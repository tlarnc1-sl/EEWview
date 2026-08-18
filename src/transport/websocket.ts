import type { SourceId } from '../types';
import { Emitter } from '../util/emitter';
import type {
  ConnectionState,
  ConnectionStatus,
  EventStream,
  SourceMessage,
} from './types';

/**
 * 再接続とハートビート監視付きのWebSocket。
 *
 * このクラスは**どのソースに繋いでいるかを知らない**。
 * URLとタイムアウト値だけを受け取り、生のペイロードを流す。
 * 中身の解釈は adapters/ の仕事。
 */

export interface WsTransportOptions {
  id: SourceId;
  url: string;
  /**
   * この時間メッセージが途絶えたら死んだとみなす。
   * Wolfxは毎分ハートビートを送ってくるので既定90秒。
   */
  heartbeatTimeoutMs?: number;
  /** ハートビートに返す文字列（Wolfxは ping 推奨）。null なら返さない */
  pingPayload?: string | null;
  /** ping を送る間隔 */
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** テスト用の差し替え口 */
  now?: () => number;
  wsFactory?: (url: string) => WebSocketLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** テストで差し替えられるよう、使う分だけを型にする */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const OPEN = 1;

export class WsTransport implements EventStream {
  readonly id: SourceId;

  private readonly url: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly pingPayload: string | null;
  private readonly pingIntervalMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly messages = new Emitter<SourceMessage>();
  private readonly states = new Emitter<ConnectionState>();

  private ws: WebSocketLike | null = null;
  private started = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: ConnectionState;
  private pingSentAt: number | null = null;

  constructor(options: WsTransportOptions) {
    this.id = options.id;
    this.url = options.url;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
    this.pingPayload = options.pingPayload ?? null;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.minBackoffMs = options.minBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.wsFactory =
      options.wsFactory ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    /*
     * ブラウザの setTimeout / clearTimeout は window に束縛されていないと
     * 「Illegal invocation」で落ちる。プロパティに入れて this.setTimeoutFn(...)
     * と呼ぶと this がこのインスタンスになるため、必ず束縛し直す。
     * Node と jsdom はこれを許すので、テストだけでは気づけない。
     */
    this.setTimeoutFn = (options.setTimeoutFn ?? setTimeout).bind(globalThis);
    this.clearTimeoutFn = (options.clearTimeoutFn ?? clearTimeout).bind(globalThis);

    this.currentState = {
      source: this.id,
      status: 'idle',
      lastMessageAt: null,
      since: this.now(),
      attempt: 0,
      nextRetryAt: null,
      detail: null,
    };
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /**
   * 最後に ping を送った時刻。応答が返ってきたときの往復時間を出すのに使う。
   * 時刻推定はこのクラスの仕事ではないので、材料だけ外に出す。
   */
  get lastPingAt(): number | null {
    return this.pingSentAt;
  }

  onMessage(fn: (m: SourceMessage) => void): () => void {
    return this.messages.subscribe(fn);
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    // 購読した時点の状態を必ず1回流す（UIが不定状態から始まらないように）
    fn(this.currentState);
    return this.states.subscribe(fn);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.closeSocket();
    this.setState('closed', { detail: null, nextRetryAt: null });
  }

  /**
   * 外部トリガによる即時再接続。
   * navigator.onLine の復帰や visibilitychange から呼ぶ。
   * バックオフ待ちを飛ばして今すぐ繋ぎ直す。
   */
  reconnectNow(reason: string): void {
    if (!this.started) return;
    if (this.currentState.status === 'open') return;
    this.clearTimers();
    this.closeSocket();
    this.attempt = 0;
    this.setState('reconnecting', { detail: reason, nextRetryAt: null });
    this.connect();
  }

  private connect(): void {
    if (!this.started) return;

    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', {
      nextRetryAt: null,
    });

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.url);
    } catch (err) {
      this.scheduleReconnect(`接続失敗: ${describe(err)}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState('open', {
        detail: null,
        nextRetryAt: null,
        lastMessageAt: this.now(),
      });
      this.armWatchdog();
      this.armPing();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const receivedAt = this.now();
      // ハートビートもデータも区別せず「生きている証拠」として扱う。
      // 中身の判別は adapters/ の仕事。
      if (this.currentState.status !== 'open') {
        this.setState('open', { detail: null, lastMessageAt: receivedAt });
      } else {
        this.patchState({ lastMessageAt: receivedAt });
      }
      this.armWatchdog();
      this.messages.emit({ source: this.id, payload: ev.data, receivedAt });
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // onerror の直後に onclose も来るので、ここでは再接続を予約しない
      this.patchState({ detail: '接続エラー' });
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (!this.started) {
        this.setState('closed', { detail: null, nextRetryAt: null });
        return;
      }
      this.scheduleReconnect('切断');
    };
  }

  /** ハートビート監視。無音が続いたら stale にして繋ぎ直す */
  private armWatchdog(): void {
    if (this.watchdogTimer !== null) this.clearTimeoutFn(this.watchdogTimer);
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.setState('stale', {
        detail: `${Math.round(this.heartbeatTimeoutMs / 1000)}秒無音`,
      });
      this.closeSocket();
      this.scheduleReconnect('ハートビート途絶');
    }, this.heartbeatTimeoutMs);
  }

  private armPing(): void {
    if (this.pingPayload === null) return;
    if (this.pingTimer !== null) this.clearTimeoutFn(this.pingTimer);
    const tick = () => {
      if (this.ws && this.ws.readyState === OPEN) {
        try {
          this.ws.send(this.pingPayload as string);
          this.pingSentAt = this.now();
        } catch {
          // 送信できないなら watchdog が拾う
        }
      }
      this.pingTimer = this.setTimeoutFn(tick, this.pingIntervalMs);
    };
    this.pingTimer = this.setTimeoutFn(tick, this.pingIntervalMs);
  }

  private scheduleReconnect(detail: string): void {
    if (!this.started) return;
    this.clearTimers();
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    const nextRetryAt = this.now() + delay;
    this.setState('reconnecting', { detail, nextRetryAt });
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** 指数バックオフ + ジッタ（全クライアントが同時に殺到しないように） */
  private backoffDelay(attempt: number): number {
    const base = Math.min(this.minBackoffMs * 2 ** attempt, this.maxBackoffMs);
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onclose = ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      // 閉じられないソケットは捨てる
    }
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.watchdogTimer, this.pingTimer]) {
      if (t !== null) this.clearTimeoutFn(t);
    }
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.pingTimer = null;
  }

  private setState(
    status: ConnectionStatus,
    patch: Partial<Omit<ConnectionState, 'source' | 'status' | 'since'>> = {},
  ): void {
    this.currentState = {
      ...this.currentState,
      status,
      since: this.now(),
      attempt: this.attempt,
      ...patch,
    };
    this.states.emit(this.currentState);
  }

  private patchState(
    patch: Partial<Omit<ConnectionState, 'source' | 'status' | 'since'>>,
  ): void {
    this.currentState = { ...this.currentState, ...patch };
    this.states.emit(this.currentState);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
