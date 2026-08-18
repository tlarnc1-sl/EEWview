// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/app';
import { EventStore } from '../src/store/store';
import { connectPipeline } from '../src/pipeline';
import { ScenarioInjector } from '../src/testing/injector';
import { SCENARIOS } from '../src/testing/scenarios';
import type { AppInput } from '../src/ui/app';
import { parseP2pMessage } from '../src/adapters/p2p';

/**
 * main.ts と同じ配線を組み、設定のボタンを実際に押して画面が変わることを見る。
 * ここが通らないなら、動作確認の機能そのものが動いていない。
 */

let now = Date.parse('2026-08-17T01:00:00Z');
let store: EventStore;
let injector: ScenarioInjector;
let app: App;

function render(): void {
  const input: AppInput = {
    snapshot: store.snapshot(now),
    connections: new Map(),
    clock: { status: 'ok', offsetMs: 0, samples: 3 },
    degradedReasons: [],
  };
  app.render(input);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  store = new EventStore({ now: () => now });
  injector = new ScenarioInjector(() => now);

  app = new App({
    endpoint: 'wss://api.p2pquake.net/v2/ws',
    environment: 'production',
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      run: () => injector.run(s),
    })),
    onClear: () => injector.forget(store),
  });
  document.body.appendChild(app.el);

  connectPipeline(injector, store, { now: () => now });
  store.onChange(() => render());
  injector.watch(() => {
    app.setTestLabel(injector.runningLabel);
    render();
  });
  render();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 設定を開いて、名前でシナリオのボタンを押す */
function runScenario(label: string): void {
  (app.el.querySelector('.settings-button') as HTMLButtonElement).click();
  const button = [...app.el.querySelectorAll('.settings__btn')].find((b) =>
    (b.textContent ?? '').includes(label),
  ) as HTMLButtonElement;
  expect(button, label).toBeDefined();
  button.click();
}

describe('設定から動作確認を実行する', () => {
  it('EEWのシナリオで左の列が開く', () => {
    runScenario('茨城県南部');
    // 地震が起きる前から始まるので、第1報が届くまで待つ
    vi.advanceTimersByTime(1_000);
    expect(app.el.querySelector('.eew')).toBeNull();
    vi.advanceTimersByTime(6_000);

    const card = app.el.querySelector('.eew')!;
    expect(app.el.classList.contains('app--eew')).toBe(true);
    expect(app.el.classList.contains('app--alert')).toBe(true);
    expect(card.textContent).toContain('茨城県南部');
    expect(card.querySelector('.eew__intensity-value')!.textContent).toBe('3');

    // 報が重なると予測震度が上がり、途中で切り替わる
    vi.advanceTimersByTime(60_000);
    const later = app.el.querySelector('.eew')!;
    expect(later.querySelector('.eew__intensity-value')!.textContent).toBe('5−');
    expect(later.classList.contains('eew--warn')).toBe(true);
    expect(later.textContent).toContain('緊急地震速報（警報）');
    // 実データの対象地域7つが震度別にまとまる
    expect(later.textContent).toContain('強い揺れ 7地域');
    expect(later.textContent).toContain('栃木県南部');
  });

  it('EEW受信中はEEWの列に判定待ちを出し、津波の列は開かない', () => {
    runScenario('茨城県南部');
    vi.advanceTimersByTime(7_000);
    expect(app.el.querySelector('.eew-overlay .pending')!.textContent).toBe(
      '津波 調査中',
    );
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
  });

  it('津波のシナリオで区域が表示される', () => {
    runScenario('津波 MajorWarning');
    vi.advanceTimersByTime(100);

    const column = app.el.querySelector('.main__tsunami')!;
    expect(column.textContent).toContain('岩手県');
    expect(column.textContent).toContain('大津波警報');
    expect(app.el.classList.contains('app--tsunami')).toBe(true);
  });

  it('投入中はテスト中であることが画面に出る', () => {
    runScenario('茨城県南部');
    vi.advanceTimersByTime(1_000);
    expect(app.el.querySelector('.compact')!.textContent).toContain('テスト投入中');

    vi.advanceTimersByTime(70_000);
    expect(app.el.querySelector('.compact')!.textContent).not.toContain('テスト投入中');
  });
});

describe('投入した分だけを取り消す', () => {
  it('実際に受信した内容は消さない', () => {
    // 実接続で受けた地震情報を1件入れておく
    const real = {
      code: 551,
      id: 'real-record',
      time: '2026/08/17 09:58:00.000',
      issue: { type: 'DetailScale', time: '2026/08/17 09:58:00' },
      earthquake: {
        time: '2026/08/17 09:57:00',
        maxScale: 30,
        hypocenter: {
          name: '茨城県沖',
          latitude: 36.5,
          longitude: 141,
          depth: 40,
          magnitude: 4.5,
        },
      },
      points: [{ addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 30 }],
    };
    store.ingest(parseP2pMessage(real, { receivedAt: now, now }));
    expect(store.snapshot(now).quakes).toHaveLength(1);

    runScenario('津波 MajorWarning');
    vi.advanceTimersByTime(100);
    expect(store.snapshot(now).tsunami).not.toBeNull();

    injector.forget(store);
    render();

    // 投入した津波だけが消え、実受信の地震は残る
    expect(store.snapshot(now).tsunami).toBeNull();
    expect(store.snapshot(now).quakes).toHaveLength(1);
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
  });

  it('投入したEEWも取り消せる', () => {
    runScenario('茨城県南部');
    vi.advanceTimersByTime(70_000);
    expect(store.getActiveEew(now)).not.toBeNull();

    injector.forget(store);
    render();
    expect(store.getActiveEew(now)).toBeNull();
    expect(app.el.querySelector('.eew')).toBeNull();
    expect(app.el.classList.contains('app--eew')).toBe(false);
  });
});
