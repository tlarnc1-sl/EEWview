import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsTransport, type WebSocketLike } from '../src/transport/websocket';
import type { ConnectionState, SourceMessage } from '../src/transport/types';

/** テスト用の偽WebSocket。open/close/message を手で起こす */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** サーバー側から切られた場合 */
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function makeTransport(overrides = {}) {
  const messages: SourceMessage[] = [];
  const states: ConnectionState[] = [];
  const transport = new WsTransport({
    id: 'wolfx',
    url: 'wss://example.test/ws',
    heartbeatTimeoutMs: 90_000,
    pingPayload: 'ping',
    pingIntervalMs: 30_000,
    minBackoffMs: 1_000,
    wsFactory: (url) => new FakeSocket(url),
    ...overrides,
  });
  transport.onMessage((m) => messages.push(m));
  transport.onState((s) => states.push(s));
  return { transport, messages, states };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WsTransport', () => {
  it('接続してメッセージを素通しする（中身は解釈しない）', () => {
    const { transport, messages } = makeTransport();
    transport.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    expect(transport.state.status).toBe('open');

    ws.message('{"任意の生文字列":1}');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.payload).toBe('{"任意の生文字列":1}');
    expect(messages[0]!.source).toBe('wolfx');
  });

  it('購読時にいまの状態を1回流す（UIが不定状態で始まらない）', () => {
    const { states } = makeTransport();
    expect(states[0]!.status).toBe('idle');
  });

  it('ハートビートが途絶えたら stale にして繋ぎ直す', () => {
    const { transport, states } = makeTransport();
    transport.start();
    FakeSocket.instances[0]!.open();

    vi.advanceTimersByTime(89_000);
    expect(transport.state.status).toBe('open');

    vi.advanceTimersByTime(2_000);
    expect(states.some((s) => s.status === 'stale')).toBe(true);
    expect(transport.state.status).toBe('reconnecting');
    expect(transport.state.detail).toBe('ハートビート途絶');
  });

  it('メッセージが来ている間は stale にならない', () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(60_000);
      ws.message('{"type":"heartbeat"}');
    }
    vi.advanceTimersByTime(60_000);
    expect(transport.state.status).toBe('open');
  });

  it('ハートビートに ping を返す', () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toEqual(['ping']);
  });

  it('ping を送った時刻を外に出す（応答の往復時間を測るため）', () => {
    const { transport } = makeTransport({ now: () => 1_000 });
    expect(transport.lastPingAt).toBeNull();
    transport.start();
    FakeSocket.instances[0]!.open();
    vi.advanceTimersByTime(30_000);
    expect(transport.lastPingAt).toBe(1_000);
  });

  it('切断されたら指数バックオフで繋ぎ直す', () => {
    const { transport } = makeTransport();
    transport.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.serverClose();

    expect(transport.state.status).toBe('reconnecting');
    expect(transport.state.nextRetryAt).not.toBeNull();

    // ジッタがあるので上限で進める
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.serverClose();
    vi.advanceTimersByTime(1_000);
    // 2回目はまだ待っている（1回目より長い）
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('再接続に成功したら attempt が戻る', () => {
    const { transport } = makeTransport();
    transport.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.serverClose();
    vi.advanceTimersByTime(1_000);
    FakeSocket.instances[1]!.open();
    expect(transport.state.status).toBe('open');
    expect(transport.state.attempt).toBe(0);
  });

  it('外部トリガでバックオフ待ちを飛ばして繋ぎ直す', () => {
    const { transport } = makeTransport();
    transport.start();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.serverClose();
    transport.reconnectNow('オンライン復帰');
    expect(FakeSocket.instances).toHaveLength(2);
    expect(transport.state.detail).toBe('オンライン復帰');
  });

  it('stop したら再接続しない', () => {
    const { transport } = makeTransport();
    transport.start();
    FakeSocket.instances[0]!.open();
    transport.stop();
    expect(transport.state.status).toBe('closed');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('接続前は open ではない（静かな画面と区別できる）', () => {
    const { transport } = makeTransport();
    transport.start();
    expect(transport.state.status).toBe('connecting');
  });
});

describe('ブラウザの setTimeout の縛り', () => {
  /**
   * ブラウザの setTimeout / clearTimeout は window に束縛されていないと
   * TypeError（Illegal invocation）になる。Node と jsdom はこれを許すので、
   * ここで同じ厳しさを再現して固定する。
   *
   * この束縛を忘れると ws.onmessage の中で例外になり、
   * 「接続は緑なのにデータが一切届かない」という壊れ方をする。
   */
  function strictTimers() {
    const strictSetTimeout = function (this: unknown, ...args: unknown[]) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return (globalThis.setTimeout as (...a: unknown[]) => unknown)(...args);
    } as unknown as typeof setTimeout;
    const strictClearTimeout = function (this: unknown, ...args: unknown[]) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return (globalThis.clearTimeout as (...a: unknown[]) => unknown)(...args);
    } as unknown as typeof clearTimeout;
    return { strictSetTimeout, strictClearTimeout };
  }

  it('厳しい setTimeout でもメッセージが流れる', () => {
    const { strictSetTimeout, strictClearTimeout } = strictTimers();
    const { transport, messages } = makeTransport({
      setTimeoutFn: strictSetTimeout,
      clearTimeoutFn: strictClearTimeout,
    });

    transport.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    expect(transport.state.status).toBe('open');

    ws.message('{"code":551}');
    // ここで例外になると、接続は緑のままデータだけ来なくなる
    expect(messages).toHaveLength(1);

    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toEqual(['ping']);
  });
});
