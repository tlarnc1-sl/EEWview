import type { SourceId } from '../types';
import { Emitter } from '../util/emitter';
import type { ConnectionState, EventStream, SourceMessage } from '../transport/types';
import type { Scenario, ScenarioStep } from './scenarios';

/**
 * 動作確認用の電文を、実接続とまったく同じ入口に流し込む。
 *
 * WsTransport と同じ EventStream を実装しているので、pipeline から見ると
 * 実接続と区別が付かない。adapters・重複排除・履歴判定・描画がすべて
 * 本番と同じ経路で動く。
 *
 * ただし**投入したことは画面から見えている必要がある**。
 * 試したデータを本物と取り違えたら、この計器は嘘をつくことになる。
 * running / lastScenario を UI に出すのはそのため。
 */
export class ScenarioInjector implements EventStream {
  // pipeline はメッセージごとの source を見るので、この id は使われない。
  // 実接続の状態表示に混ざらないよう、接続としては常に停止扱いにしておく。
  readonly id: SourceId = 'p2p';

  private readonly messages = new Emitter<SourceMessage>();
  private readonly states = new Emitter<ConnectionState>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** 投入した電文のID。取り消すときに、この分だけを消す */
  private readonly injectedIds = new Set<string>();
  private activeScenario: Scenario | null = null;
  private onChange: (() => void) | null = null;

  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(
    private readonly now: () => number = () => Date.now(),
    setTimeoutFn: typeof setTimeout = setTimeout,
    clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ) {
    // ブラウザでは window に束縛しないと Illegal invocation になる
    this.setTimeoutFn = setTimeoutFn.bind(globalThis);
    this.clearTimeoutFn = clearTimeoutFn.bind(globalThis);
  }

  get state(): ConnectionState {
    return {
      source: this.id,
      status: 'closed',
      lastMessageAt: null,
      since: this.now(),
      attempt: 0,
      nextRetryAt: null,
      detail: null,
    };
  }

  /** 実行中のシナリオ名。null なら何も投入していない */
  get runningLabel(): string | null {
    return this.activeScenario?.label ?? null;
  }

  start(): void {
    // 実接続ではないので、開始も停止も持たない
  }

  stop(): void {
    this.cancel();
  }

  onMessage(fn: (m: SourceMessage) => void): () => void {
    return this.messages.subscribe(fn);
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    fn(this.state);
    return this.states.subscribe(fn);
  }

  /** 状態が変わったときにUIへ知らせる（投入中の表示を出すため） */
  watch(fn: () => void): void {
    this.onChange = fn;
  }

  /** シナリオを実行する。実行中のものがあれば止めて置き換える */
  run(scenario: Scenario): void {
    this.cancel();
    this.activeScenario = scenario;
    this.onChange?.();

    const startedAt = this.now();
    const steps = scenario.build(startedAt);
    let remaining = steps.length;

    for (const step of steps) {
      const timer = this.setTimeoutFn(() => {
        this.emit(step);
        remaining -= 1;
        if (remaining <= 0) {
          this.activeScenario = null;
          this.onChange?.();
        }
      }, step.delayMs);
      this.timers.push(timer);
    }
  }

  /** 途中で止める。投入済みのイベントはストアに残る */
  cancel(): void {
    for (const t of this.timers) this.clearTimeoutFn(t);
    this.timers = [];
    if (this.activeScenario !== null) {
      this.activeScenario = null;
      this.onChange?.();
    }
  }

  /** 投入した分だけをストアから取り除く。実受信の内容には触らない */
  forget(store: { forget(ids: Iterable<string>): boolean }): boolean {
    this.cancel();
    const removed = store.forget(this.injectedIds);
    this.injectedIds.clear();
    return removed;
  }

  /** 何か投入したか（取り消しボタンを出すかの判断に使う） */
  get hasInjected(): boolean {
    return this.injectedIds.size > 0;
  }

  private emit(step: ScenarioStep): void {
    for (const id of identifiersOf(step.payload)) this.injectedIds.add(id);
    this.messages.emit({
      source: step.source,
      payload: step.payload,
      receivedAt: this.now(),
    });
  }
}

/**
 * 電文からストア側のキーになりうるIDを拾う。
 * Wolfxは EventID、P2Pはレコードの id と issue.eventId。
 */
function identifiersOf(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const rec = payload as Record<string, unknown>;
  const out: string[] = [];
  for (const v of [rec['EventID'], rec['id']]) {
    if (typeof v === 'string') out.push(v);
  }
  const issue = rec['issue'];
  if (typeof issue === 'object' && issue !== null) {
    const eventId = (issue as Record<string, unknown>)['eventId'];
    if (typeof eventId === 'string') out.push(eventId);
  }
  return out;
}
