import { parseP2pMessage } from './adapters/p2p';
import { parseWolfxMessage } from './adapters/wolfx';
import type { EventStore } from './store/store';
import type { EventStream, SourceMessage } from './transport/types';
import type { AdapterResult } from './types';

/**
 * 受信 → 正規化 → ストア。
 *
 * ストリームが実接続か再生かをここは知らない。SourceMessage の source だけを見て
 * adapter を選ぶ。再生を特別扱いしないための一本道。
 */

export interface PipelineOptions {
  /** 履歴判定に使う現在時刻。補正済みサーバー時刻を渡す */
  now: () => number;
}

export function normalize(m: SourceMessage, now: number): AdapterResult {
  switch (m.source) {
    case 'wolfx':
      return parseWolfxMessage(m.payload, { receivedAt: m.receivedAt, now });
    case 'p2p':
      return parseP2pMessage(m.payload, { receivedAt: m.receivedAt, now });
    default:
      return null;
  }
}

export function connectPipeline(
  stream: EventStream,
  store: EventStore,
  options: PipelineOptions,
): () => void {
  return stream.onMessage((m) => {
    store.ingest(normalize(m, options.now()));
  });
}
