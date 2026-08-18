import type { SourceId } from '../types';

/**
 * 受信レイヤーの共通インターフェイス。
 *
 * ここはどのソースに繋いでいるかを知らない。URLとタイムアウト値だけを受け取り、
 * 生のペイロードを流す。中身の解釈は adapters/ の仕事。
 */

export type ConnectionStatus =
  | 'idle' // まだ start() されていない
  | 'connecting'
  | 'open'
  | 'stale' // 接続はあるがハートビートが途絶えている
  | 'reconnecting'
  | 'closed' // 意図的に停止した
  | 'error';

export interface ConnectionState {
  readonly source: SourceId;
  readonly status: ConnectionStatus;
  /** 最後にメッセージ（ハートビート含む）を受けた時刻 */
  readonly lastMessageAt: number | null;
  /** この status になった時刻 */
  readonly since: number;
  /** 連続再接続回数。0 なら安定している */
  readonly attempt: number;
  /** 次の再接続予定時刻 */
  readonly nextRetryAt: number | null;
  /** 画面に出す補足（"タイムアウト" など）。null なら補足なし */
  readonly detail: string | null;
}

export interface SourceMessage {
  readonly source: SourceId;
  /** 生のペイロード。文字列で来たものは文字列のまま渡す */
  readonly payload: unknown;
  readonly receivedAt: number;
}

/**
 * イベント供給源。WsTransport が実装する。
 * 上位（pipeline / store）はこの型しか見ない。
 */
export interface EventStream {
  readonly id: SourceId;
  readonly state: ConnectionState;
  start(): void;
  stop(): void;
  onMessage(fn: (m: SourceMessage) => void): () => void;
  onState(fn: (s: ConnectionState) => void): () => void;
}

/** 接続が生きているとみなせるか（フェイルサイレント判定に使う） */
export function isHealthy(state: ConnectionState): boolean {
  return state.status === 'open';
}
