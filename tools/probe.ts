/**
 * 実際に繋いで、受信 → 正規化 → ストアが通ることを確かめる小道具。
 *
 *   npx vite-node tools/probe.ts [秒数] [production|sandbox]
 *
 * ブラウザを開かずに接続まわりを確かめるためのもの。テストではない。
 * 既定は本番。無音の間隔（＝ハートビート監視の閾値の根拠）も測る。
 */
import { WsTransport } from '../src/transport/websocket';
import { EventStore } from '../src/store/store';
import { connectPipeline } from '../src/pipeline';
import { formatJstTime } from '../src/util/jst';
import { Clock } from '../src/clock';
import { readWolfxServerTime } from '../src/adapters/wolfx';

const seconds = Number(process.argv[2] ?? 40);
const useSandbox = process.argv[3] === 'sandbox';
const store = new EventStore();

const p2p = new WsTransport({
  id: 'p2p',
  url: useSandbox
    ? 'wss://api-realtime-sandbox.p2pquake.net/v2/ws'
    : 'wss://api.p2pquake.net/v2/ws',
  // 監視の閾値を測るのが目的なので、ここでは切らない
  heartbeatTimeoutMs: seconds * 1000 + 60_000,
});
const wolfx = new WsTransport({
  id: 'wolfx',
  url: 'wss://ws-api.wolfx.jp/jma_eew',
  heartbeatTimeoutMs: 90_000,
  pingPayload: 'ping',
});

// main.ts と同じ配線で時刻推定を確かめる
const clock = new Clock();
wolfx.onMessage((m) => {
  const server = readWolfxServerTime(m.payload);
  if (!server || !server.isPong) return;
  const sentAt = wolfx.lastPingAt;
  if (sentAt === null) return;
  clock.addSample(server.serverTime, sentAt, m.receivedAt);
});

let received = 0;
/** ソース別の無音の最大長。ハートビート監視の閾値の根拠になる */
const gaps = new Map<string, { last: number; max: number; count: number }>();

for (const t of [p2p, wolfx]) {
  connectPipeline(t, store, { now: () => Date.now() });
  t.onMessage((m) => {
    received += 1;
    const g = gaps.get(m.source) ?? { last: Date.now(), max: 0, count: 0 };
    g.max = Math.max(g.max, Date.now() - g.last);
    g.last = Date.now();
    g.count += 1;
    gaps.set(m.source, g);
    const head =
      typeof m.payload === 'string' ? m.payload.slice(0, 60) : String(m.payload);
    console.log(`  ${m.source} << ${head}`);
  });
  t.onState((s) => {
    console.log(`[${s.source}] ${s.status}${s.detail ? ` (${s.detail})` : ''}`);
  });
  t.start();
}

setTimeout(() => {
  const snap = store.snapshot();
  console.log('\n--- 結果 ---');
  console.log(`接続先: ${useSandbox ? 'サンドボックス' : '本番'}`);
  console.log(`受信メッセージ: ${received}`);
  for (const [source, g] of gaps) {
    console.log(`  ${source}: ${g.count}件 / 最大無音 ${Math.round(g.max / 1000)}秒`);
  }
  console.log(`解析失敗: ${snap.parseFailures}`, snap.lastParseFailure?.reason ?? '');
  console.log(`地震: ${snap.quakes.length} / EEW: ${snap.recentEews.length}`);
  for (const q of snap.quakes.slice(0, 5)) {
    console.log(
      `  ${formatJstTime(q.occurredAt)} ${q.hypocenter.name ?? '震源調査中'}` +
        ` 最大震度${q.maxIntensity?.label ?? '—'}` +
        ` [${q.issueTypes.join(',')}] ${q.points.length}点`,
    );
  }
  console.log(`津波: ${snap.tsunami ? (snap.tsunami.cancelled ? '解除' : `${snap.tsunami.areas.length}区域`) : 'なし'}`);
  console.log(
    `時刻補正: ${clock.status} offset=${clock.offsetMs ?? '—'}ms rtt=${clock.rttMs ?? '—'}ms (${clock.sampleCount}標本)`,
  );
  console.log(`進行中EEW: ${snap.activeEew ? snap.activeEew.eventId : 'なし'}`);
  p2p.stop();
  wolfx.stop();
  process.exit(0);
}, seconds * 1000);
