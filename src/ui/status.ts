import type { ConnectionState } from '../transport/types';
import type { SourceId } from '../types';
import type { ClockStatus } from '../clock';
import type { ObserverLocation } from '../observer';
import { formatJstTime } from '../util/jst';
import { fields, h, setClass, setText } from './dom';

/**
 * 接続状態の表示。
 *
 * 詳細は設定の中に置くが、**異常は常時見えるところに出す**。
 * 静かな画面が「地震がない」のか「接続が死んでいる」のか区別できなくなったら、
 * このアプリは計器として無価値になる。
 * 平常時は点ひとつ、異常時だけ文字が出る、という重みの付け方にしている。
 */

const STATUS_LABEL: Record<ConnectionState['status'], string> = {
  idle: '未接続',
  connecting: '接続中',
  open: '受信中',
  stale: '無音',
  reconnecting: '再接続待ち',
  closed: '停止',
  error: '異常',
};

/** この状態は「繋がっている」とみなす。それ以外は異常として表に出す */
function isHealthy(state: ConnectionState | null): boolean {
  return state?.status === 'open';
}

export interface StatusInput {
  connections: Map<SourceId, ConnectionState>;
  clock: { status: ClockStatus; offsetMs: number | null; samples: number };
  parseFailures: number;
  /** 履歴取得を諦めた等、機能が落ちている理由 */
  degradedReasons: string[];
}

export interface SourceLabel {
  id: SourceId;
  label: string;
}

/** 設定に並べる動作確認の項目 */
export interface ScenarioAction {
  id: string;
  label: string;
  run: () => void;
}

/**
 * 常時見えている最小の状態表示。
 * 全部正常なら点だけ。ひとつでも落ちていれば、何が落ちているかを文字で出す。
 */
export class CompactStatus {
  readonly el: HTMLButtonElement;
  private readonly dot: HTMLElement;
  private readonly text: HTMLElement;

  constructor(
    private readonly sources: SourceLabel[],
    onOpenSettings: () => void,
  ) {
    this.dot = h('span', { class: 'compact__dot' });
    this.text = h('span', { class: 'compact__text' });
    this.el = h(
      'button',
      {
        class: 'compact',
        type: 'button',
        title: '接続状態と設定',
        'aria-label': '接続状態と設定',
      },
      this.dot,
      this.text,
    ) as HTMLButtonElement;
    this.el.addEventListener('click', onOpenSettings);
  }

  render(input: StatusInput, testLabel: string | null = null): void {
    const problems: string[] = [];
    // 試したデータを本物と取り違えないよう、投入中は常に見えるようにする
    if (testLabel !== null) problems.push(`テスト投入中: ${testLabel}`);
    for (const s of this.sources) {
      const state = input.connections.get(s.id) ?? null;
      if (!isHealthy(state)) {
        problems.push(`${s.label} ${STATUS_LABEL[state?.status ?? 'idle']}`);
      }
    }
    if (input.clock.status === 'suspect') problems.push('時刻ずれ異常');
    if (input.parseFailures > 0) problems.push(`解析失敗${input.parseFailures}`);
    problems.push(...input.degradedReasons);

    setClass(this.el, 'compact--bad', problems.length > 0);
    // 異常時だけ文字が出る。平常時は点だけ
    this.text.replaceChildren(fields('compact__fields', problems));
  }
}

/** 設定の中身。接続の詳細と時刻補正を並べる */
export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly indicators = new Map<SourceId, SourceIndicator>();
  private readonly clockEl: HTMLElement;
  private readonly observerEl: HTMLElement;
  private readonly degradedEl: HTMLElement;
  private open = false;

  constructor(
    sources: SourceLabel[],
    meta: { endpoint: string; environment: string },
    onClose: () => void,
    scenarios: ScenarioAction[] = [],
    onClear: () => void = () => {},
    observerActions: { set: () => void; clear: () => void } | null = null,
    detailActions: { enabled: boolean; onChange: (on: boolean) => void } | null = null,
  ) {
    const indicatorEls: HTMLElement[] = [];
    for (const s of sources) {
      const ind = new SourceIndicator(s.label);
      this.indicators.set(s.id, ind);
      indicatorEls.push(ind.el);
    }

    this.clockEl = h('p', {}, '未推定');
    this.observerEl = h('p', {}, '未設定');
    this.degradedEl = h('p', { class: 'settings__degraded' });

    const close = h('button', { type: 'button' }, '閉じる');
    close.addEventListener('click', onClose);

    this.el = h(
      'div',
      { class: 'settings', role: 'dialog', 'aria-label': '設定' },
      h('h2', {}, '接続と設定'),
      h('h3', {}, '受信'),
      h('ul', {}, ...indicatorEls),
      this.degradedEl,
      h('h3', {}, '時刻補正'),
      this.clockEl,
      h('h3', {}, '接続先'),
      h(
        'ul',
        {},
        h('li', {}, `P2P（${meta.environment}） ${meta.endpoint}`),
        h('li', {}, 'Wolfx wss://ws-api.wolfx.jp/jma_eew'),
      ),
      detailActions ? buildDisplay(detailActions) : null,
      observerActions ? this.buildObserver(observerActions) : null,
      scenarios.length > 0 ? this.buildScenarios(scenarios, onClear) : null,
      h('p', {}, close),
    );
    this.setOpen(false);
  }

  /**
   * 現在地。EEWを受けたときに、この地点の推定震度を出すのに使う。
   * 位置は端末に保存するだけで、どこにも送らない。
   */
  private buildObserver(actions: { set: () => void; clear: () => void }): HTMLElement {
    const set = h('button', { class: 'settings__btn', type: 'button' }, '現在地を設定する');
    set.addEventListener('click', () => actions.set());
    const clear = h('button', { class: 'settings__btn', type: 'button' }, '現在地を消す');
    clear.addEventListener('click', () => actions.clear());

    return h(
      'section',
      {},
      h('h3', {}, '現在地'),
      this.observerEl,
      h('p', {}, set, clear),
    );
  }

  /** 現在地の表示を更新する */
  setObserver(observer: ObserverLocation | null): void {
    if (observer === null) {
      setText(this.observerEl, '未設定');
      return;
    }
    const ground =
      observer.avs30 === null
        ? '地盤データなし'
        : `AVS30 ${observer.avs30.toFixed(0)} m/s${observer.jname ? ` / ${observer.jname}` : ''}`;
    setText(
      this.observerEl,
      `${observer.lat.toFixed(3)}, ${observer.lon.toFixed(3)}（${ground}）`,
    );
  }

  /**
   * 動作確認。試験用の電文を、実接続と同じ入口に流し込む。
   * 表示だけ差し替えるのではないので、パースから描画まで本番の経路を通る。
   */
  private buildScenarios(scenarios: ScenarioAction[], onClear: () => void): HTMLElement {
    const buttons = scenarios.map((s) => {
      const b = h('button', { class: 'settings__btn', type: 'button' }, s.label);
      b.addEventListener('click', () => s.run());
      return h('li', {}, b);
    });
    // 全消しにすると実際に受信した内容まで巻き添えになる。投入した分だけを戻す
    const clear = h('button', { class: 'settings__btn', type: 'button' }, '投入した分を取り消す');
    clear.addEventListener('click', onClear);

    return h(
      'section',
      {},
      h('h3', {}, '動作確認'),
      h('ul', {}, ...buttons),
      h('p', {}, clear),
    );
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.hidden = !open;
  }

  get isOpen(): boolean {
    return this.open;
  }

  render(input: StatusInput): void {
    for (const [id, ind] of this.indicators) {
      ind.render(input.connections.get(id) ?? null);
    }

    // 時刻オフセットが未推定・異常ならその旨を出す（黙って0として扱わない）
    const { clock } = input;
    if (clock.status === 'unknown') {
      setText(this.clockEl, '未推定');
    } else {
      const sign = (clock.offsetMs ?? 0) >= 0 ? '+' : '-';
      const abs = Math.abs(clock.offsetMs ?? 0);
      const value = abs >= 1000 ? `${(abs / 1000).toFixed(1)}s` : `${Math.round(abs)}ms`;
      const suspect = clock.status === 'suspect' ? '（異常）' : '';
      setText(this.clockEl, `${sign}${value}${suspect}　${clock.samples}標本`);
    }
    // 異常は太字にするだけ（設定画面は素のHTMLで組む）
    setClass(this.clockEl, 'settings__value--warn', clock.status !== 'ok');

    const reasons = [...input.degradedReasons];
    if (input.parseFailures > 0) reasons.push(`解析失敗 ${input.parseFailures}件`);
    setText(this.degradedEl, reasons.join('、'));
  }
}

/**
 * 表示の切り替え。
 * 地震情報の詳細は既定で出さない（震度は地図に出ているので）。
 * 出していないあいだ、その位置には時計が出る。
 */
function buildDisplay(actions: {
  enabled: boolean;
  onChange: (on: boolean) => void;
}): HTMLElement {
  const box = h('input', { class: 'settings__check', type: 'checkbox' }) as HTMLInputElement;
  box.checked = actions.enabled;
  box.addEventListener('change', () => actions.onChange(box.checked));

  return h(
    'section',
    {},
    h('h3', {}, '表示'),
    h('p', {}, h('label', {}, box, ' 地震情報の詳細を出す（観測点別の震度）')),
  );
}

/**
 * 受信元1つぶんの状態。**設定画面は素のHTMLで組む**ので、
 * 色の丸も枠も持たず、文字だけの箇条書き（li）にする。
 * 状態は文字で言えば足りる（緑の丸が何色だったかを覚えるより速い）。
 */
class SourceIndicator {
  readonly el: HTMLElement;

  constructor(private readonly name: string) {
    this.el = h('li', {}, `${name} 未接続`);
  }

  render(state: ConnectionState | null): void {
    const status = state?.status ?? 'idle';
    const notes: string[] = [];
    if (state?.detail) notes.push(state.detail);
    // 「接続が終わった時刻」ではなく「最後に何か届いた時刻」。
    // p2pはハートビートを送らないので、接続が開いていることは受信の証明にならない。
    if (state?.lastMessageAt) {
      notes.push(`最終受信 ${formatJstTime(state.lastMessageAt)}`);
    }
    if (state?.attempt) notes.push(`再試行${state.attempt}回目`);

    const head = `${this.name} ${STATUS_LABEL[status]}`;
    setText(this.el, notes.length === 0 ? head : `${head}（${notes.join('、')}）`);
  }
}
