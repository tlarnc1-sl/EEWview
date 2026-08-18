import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENARIOS } from '../src/testing/scenarios';
import { ScenarioInjector } from '../src/testing/injector';
import { EventStore } from '../src/store/store';
import { connectPipeline } from '../src/pipeline';
import { parseP2pMessage } from '../src/adapters/p2p';
import { parseWolfxMessage } from '../src/adapters/wolfx';

/**
 * 動作確認の電文が、実接続と同じ経路を通ることを固定する。
 * ここが壊れると「試したつもり」で何も確かめていない状態になる。
 */

const NOW = Date.parse('2026-08-17T00:30:00Z');

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function runScenario(id: string) {
  const store = new EventStore({ now: () => NOW });
  const injector = new ScenarioInjector(() => NOW);
  connectPipeline(injector, store, { now: () => NOW });
  injector.run(scenario(id));
  vi.advanceTimersByTime(60_000);
  return store;
}

describe('シナリオの電文', () => {
  it('実データと同じ形の生JSONを作る（正規化済みイベントではない）', () => {
    const steps = scenario('eew-forecast').build(NOW);
    const raw = steps[0]!.payload as Record<string, unknown>;
    // 生の電文であること。API側の綴り誤りもそのまま
    expect(raw).toHaveProperty('Magunitude');
    expect(raw).toHaveProperty('OriginalText');
    expect(raw).not.toHaveProperty('kind');
    // adapter がそのまま読める
    const e = parseWolfxMessage(raw, { receivedAt: NOW, now: NOW });
    expect(e?.kind).toBe('eew');
  });

  it('地震が起きる前から始まる（予報円が0から広がるように）', () => {
    const steps = scenario('eew-forecast').build(NOW);
    const first = steps[0]!.payload as Record<string, unknown>;
    // 発震は投入時刻より後
    const origin = Date.parse(
      (first['OriginTime'] as string).replace(/\//g, '-').replace(' ', 'T') + '+09:00',
    );
    expect(origin).toBeGreaterThan(NOW);
    // 第1報は発震の数秒後に届く（すぐには来ない）
    expect(steps[0]!.delayMs).toBeGreaterThan(2_000);
    // 最後の報は実データどおり発震から56秒後
    expect(steps[steps.length - 1]!.delayMs - steps[0]!.delayMs).toBe(52_000);
  });

  it('投入時刻を基準に組むので履歴扱いにならない', () => {
    for (const s of SCENARIOS) {
      for (const step of s.build(NOW)) {
        const parsed =
          step.source === 'wolfx'
            ? parseWolfxMessage(step.payload, { receivedAt: NOW, now: NOW })
            : parseP2pMessage(step.payload, { receivedAt: NOW, now: NOW });
        if (parsed && 'historical' in parsed) {
          expect(parsed.historical, `${s.id}`).toBe(false);
        }
      }
    }
  });
});

describe('EEWのシナリオ', () => {
  it('連続報が重なり、最後の報（実データの第12報）の内容が残る', () => {
    const store = runScenario('eew-forecast');
    const eew = store.getActiveEew(NOW);
    expect(eew).not.toBeNull();
    expect(eew!.serial).toBe(12);
    // 実データは MaxIntensity が "5弱" 表記
    expect(eew!.maxIntensity!.label).toBe('5弱');
    expect(eew!.hypocenter.name).toBe('茨城県南部');
    expect(eew!.hypocenter.magnitude).toBe(5.1);
    expect(eew!.hypocenter.depthKm).toBe(60);
    expect(eew!.isWarn).toBe(true);
    expect(eew!.isFinal).toBe(true);
    // 実データの対象地域7つがそのまま入る
    expect(eew!.warnAreas).toHaveLength(7);
    expect(eew!.warnAreas[0]!.name).toBe('栃木県南部');
    expect(eew!.warnAreas[0]!.arrive).toContain('PLUM');
    // 生電文も実物のまま
    expect(eew!.originalText).toContain('RK44559');
    expect(eew!.accuracy?.epicenterCode).toBe(4);
    // 報が1件にまとまっている
    expect(store.snapshot(NOW).recentEews).toHaveLength(1);
  });

  it('予報から警報へ切り替わる（対象地域は警報から載る）', () => {
    const steps = scenario('eew-forecast').build(NOW);
    const first = steps[0]!.payload as Record<string, unknown>;
    const last = steps[steps.length - 1]!.payload as Record<string, unknown>;
    expect(first['Title']).toBe('緊急地震速報（予報）');
    expect(first['isWarn']).toBe(false);
    expect(first['WarnArea']).toEqual([]);
    expect(last['Title']).toBe('緊急地震速報（警報）');
    expect(last['isWarn']).toBe(true);
    expect((last['WarnArea'] as unknown[]).length).toBe(7);
  });

  it('毎回EventIDを変える（2回目が重複排除で捨てられないように）', () => {
    const a = scenario('eew-forecast').build(NOW)[0]!.payload as Record<string, unknown>;
    const b = scenario('eew-forecast').build(NOW + 60_000)[0]!.payload as Record<
      string,
      unknown
    >;
    expect(a['EventID']).not.toBe(b['EventID']);
    // 実データのIDは使わない
    expect(a['EventID']).not.toBe('20260401100625');
  });

  it('取消のあとに来た報は破棄される（実接続と同じ判定）', () => {
    const store = runScenario('eew-cancel');
    const eew = store.getActiveEew(NOW);
    expect(eew!.isCancel).toBe(true);
    // 取消後の報は捨てられている
    expect(eew!.serial).toBe(20);
    expect(store.snapshot(NOW).discarded).toBeGreaterThan(0);
  });

  it('EEWはWolfxからだけ入る', () => {
    const store = runScenario('eew-forecast');
    expect(store.getActiveEew(NOW)!.receivedFrom).toBe('wolfx');
  });
});

describe('予報円を確かめるシナリオ', () => {
  it('深発地震は深さ150kmを超える', () => {
    const store = runScenario('eew-deep');
    expect(store.getActiveEew(NOW)!.hypocenter.depthKm).toBeGreaterThan(150);
  });

  it('PLUM法のシナリオは震源決定手法がPLUM', () => {
    const store = runScenario('eew-plum');
    expect(store.getActiveEew(NOW)!.accuracy?.epicenter).toContain('PLUM');
  });
});

describe('津波のシナリオ', () => {
  it('区域つきの予報が入る', () => {
    const store = runScenario('tsunami-watch');
    const t = store.snapshot(NOW).tsunami;
    expect(t).not.toBeNull();
    expect(t!.cancelled).toBe(false);
    expect(t!.areas).toHaveLength(3);
    expect(t!.areas[0]!.grade).toBe('Watch');
  });

  it('重い階級も扱える', () => {
    const store = runScenario('tsunami-major');
    const t = store.snapshot(NOW).tsunami!;
    expect(t.areas).toHaveLength(7);
    expect(t.areas.some((a) => a.grade === 'MajorWarning')).toBe(true);
    expect(t.areas.find((a) => a.grade === 'MajorWarning')!.maxHeight).toBe('１０ｍ超');
  });

  it('解除も投入できる', () => {
    const store = runScenario('tsunami-cancel');
    const t = store.snapshot(NOW).tsunami!;
    expect(t.cancelled).toBe(true);
    expect(t.areas).toEqual([]);
  });
});

describe('ブラウザの setTimeout の縛り', () => {
  it('厳しい setTimeout でも投入できる', () => {
    const strict = function (this: unknown, ...args: unknown[]) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return (globalThis.setTimeout as (...a: unknown[]) => unknown)(...args);
    } as unknown as typeof setTimeout;

    const store = new EventStore({ now: () => NOW });
    const injector = new ScenarioInjector(() => NOW, strict);
    connectPipeline(injector, store, { now: () => NOW });
    injector.run(scenario('tsunami-watch'));
    vi.advanceTimersByTime(1_000);
    expect(store.snapshot(NOW).tsunami).not.toBeNull();
  });
});

describe('投入の可視化', () => {
  it('実行中はシナリオ名を出し、終わったら消す', () => {
    const injector = new ScenarioInjector(() => NOW);
    const seen: (string | null)[] = [];
    injector.watch(() => seen.push(injector.runningLabel));

    injector.run(scenario('eew-forecast'));
    expect(injector.runningLabel).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(injector.runningLabel).toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('途中で止められる', () => {
    const store = new EventStore({ now: () => NOW });
    const injector = new ScenarioInjector(() => NOW);
    connectPipeline(injector, store, { now: () => NOW });

    injector.run(scenario('eew-forecast'));
    // 発震の2秒後が第1報の4秒前。第1報が届くまで進める
    vi.advanceTimersByTime(7_000);
    injector.cancel();
    const serialAtCancel = store.getActiveEew(NOW)!.serial;

    vi.advanceTimersByTime(60_000);
    // 止めた後の報は流れてこない
    expect(store.getActiveEew(NOW)!.serial).toBe(serialAtCancel);
    expect(injector.runningLabel).toBeNull();
  });

  it('実接続の状態表示には混ざらない', () => {
    const injector = new ScenarioInjector(() => NOW);
    // 接続としては常に停止扱い。wolfx / p2p のランプを乗っ取らない
    expect(injector.state.status).toBe('closed');
  });
});
