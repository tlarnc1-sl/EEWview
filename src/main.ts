import './styles.css';
import { loadConfig } from './config';
import { Clock } from './clock';
import { EventStore } from './store/store';
import { WsTransport } from './transport/websocket';
import type { ConnectionState, EventStream } from './transport/types';
import type { SourceId } from './types';
import { connectPipeline, normalize } from './pipeline';
import { readWolfxServerTime } from './adapters/wolfx';
import { App } from './ui/app';
import { loadTravelTimeTable } from './lib/travelTime';
import { fetchGround } from './lib/jshis';
import { clearObserver, loadObserver, saveObserver } from './observer';
import { ScenarioInjector } from './testing/injector';
import { SCENARIOS } from './testing/scenarios';

/**
 * 起動と配線。
 *
 * WolfxとP2Pの2本のWebSocketを張り、受信 → 正規化 → ストア → 描画に流す。
 * HTTPを叩くのは起動時だけ（現在値と履歴）。以後はWebSocketだけで回る。
 */

const config = loadConfig();
const clock = new Clock();
const store = new EventStore({ now: () => clock.now() });

const connections = new Map<SourceId, ConnectionState>();
const degradedReasons = new Set<string>();

const wolfx = new WsTransport({
  id: 'wolfx',
  url: config.wolfx.ws,
  heartbeatTimeoutMs: config.wolfx.heartbeatTimeoutMs,
  // サーバのハートビートに ping を返す（推奨されている）
  pingPayload: 'ping',
  pingIntervalMs: 30_000,
});

const p2p = new WsTransport({
  id: 'p2p',
  url: config.p2p.ws,
  heartbeatTimeoutMs: config.p2p.heartbeatTimeoutMs,
  pingPayload: null,
});

/**
 * 動作確認の入口。試験用の電文を実接続と同じ pipeline に流す。
 * 表示だけ差し替えるのではないので、パース・重複排除・履歴判定・描画まで
 * 本番と同じ経路を通る。
 */
const injector = new ScenarioInjector(() => clock.now());

/** 地震情報の詳細を出すか。既定は出さない（その位置には時計が出る） */
const DETAIL_KEY = 'eew-view.detail';

function loadDetailPreference(): boolean {
  try {
    return localStorage.getItem(DETAIL_KEY) === '1';
  } catch {
    return false;
  }
}

const app = new App({
  endpoint: config.p2p.ws,
  environment: config.p2p.environment,
  detail: {
    enabled: loadDetailPreference(),
    onChange: (enabled) => {
      try {
        localStorage.setItem(DETAIL_KEY, enabled ? '1' : '0');
      } catch {
        // 覚えられなくても、その場の切り替えは効く
      }
    },
  },
  observer: {
    useGeolocation: () => void setObserverFromGeolocation(),
    pickOnMap: () => startPickingLocation(),
    dismiss: () => dismissObserverSetup(),
    clear: () => {
      clearObserver();
      app.setObserver(null);
    },
  },
  scenarios: SCENARIOS.map((scenario) => ({
    id: scenario.id,
    label: scenario.label,
    run: () => injector.run(scenario),
  })),
  // 投入した分だけを取り消す。実際に受信した内容には触らない
  onClear: () => injector.forget(store),
});
document.body.appendChild(app.el);
// 予報円の経過秒数は、補正済みの時刻から測る
app.setClock(() => clock.now());

/**
 * 走時表（JMA2001）。起動時に一度だけ読み、以後は使い回す。
 * 850KBあるのでバンドルには入れず public から取る。
 * 読めなければ予報円は出ない。黙って出ないのではなく理由を画面に出す。
 */
async function loadTravelTime(): Promise<void> {
  const url = `${import.meta.env.BASE_URL}assets/tjma2001.txt`;
  try {
    app.setTravelTimeTable(await loadTravelTimeTable(url));
  } catch (err) {
    degradedReasons.add('走時表を読めず、予報円を描けない');
    console.error('[main] travel time table', err);
  }
  render();
}

function render(): void {
  // 経過時間の表示に使うので、補正済みの時刻を渡す
  const now = clock.now();
  app.render(
    {
      snapshot: store.snapshot(now),
      connections,
      clock: {
        status: clock.status,
        offsetMs: clock.offsetMs,
        samples: clock.sampleCount,
      },
      degradedReasons: [...degradedReasons],
    },
    now,
  );
}

function watch(stream: EventStream): void {
  connectPipeline(stream, store, { now: () => clock.now() });
  stream.onState((state) => {
    connections.set(stream.id, state);
    render();
  });
}

store.onChange(() => render());

watch(wolfx);
watch(p2p);

// 実接続と同じ配線。pipeline から見ると WsTransport と区別が付かない
connectPipeline(injector, store, { now: () => clock.now() });
injector.watch(() => {
  app.setTestLabel(injector.runningLabel);
  render();
});

/*
 * Wolfxのハートビートと pong は epoch ms のサーバー時刻を載せている（実測）。
 * pong は自分が送った ping への応答なので往復時間が分かる。HTTPの Date より
 * 分解能が高いので、時刻推定はこちらを主に使う。
 */
wolfx.onMessage((m) => {
  const server = readWolfxServerTime(m.payload);
  if (!server || !server.isPong) return;
  const sentAt = wolfx.lastPingAt;
  if (sentAt === null) return;
  clock.addSample(server.serverTime, sentAt, m.receivedAt);
});

// ---- 現在地 -----------------------------------------------------------

/** 初回の案内を出したかどうか。断られたら二度と出さない */
const SETUP_DISMISSED_KEY = 'eew-view.observer.dismissed';

/**
 * 地点を確定させる。
 *
 * 地盤データ（AVS30）は J-SHIS から**このときだけ**引いて保存する。
 * 引けなければ null のまま保存し、推定震度は出さない。
 * 増幅なしで代用すると、その地点だけ実際より小さい震度が出る。
 */
async function setObserverAt(lat: number, lon: number): Promise<void> {
  app.setObserverSetupStatus('地盤データを取得中…');
  const ground = await fetchGround(lat, lon);
  const saved = saveObserver({
    lat,
    lon,
    label: null,
    avs30: ground?.avs30 ?? null,
    jname: ground?.jname ?? null,
  });
  app.setObserver(saved);
  app.setObserverSetupStatus(
    ground === null
      ? '地盤データを取得できませんでした（推定震度は出しません）'
      : `設定しました（AVS30 ${ground.avs30.toFixed(0)} m/s）`,
  );
  if (ground !== null) {
    window.setTimeout(() => app.openObserverSetup(false), 1_200);
  }
}

async function setObserverFromGeolocation(): Promise<void> {
  if (!('geolocation' in navigator)) {
    app.setObserverSetupStatus('この環境では位置情報を取得できません');
    return;
  }
  app.setObserverSetupStatus('位置情報を取得中…');
  navigator.geolocation.getCurrentPosition(
    (pos) => void setObserverAt(pos.coords.latitude, pos.coords.longitude),
    (err) => app.setObserverSetupStatus(`位置情報を取得できません（${err.message}）`),
    { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
  );
}

function startPickingLocation(): void {
  app.openObserverSetup(false);
  app.setPickingLocation(true, (lat, lon) => {
    app.setPickingLocation(false, () => {});
    app.openObserverSetup(true);
    void setObserverAt(lat, lon);
  });
}

function dismissObserverSetup(): void {
  try {
    localStorage.setItem(SETUP_DISMISSED_KEY, '1');
  } catch {
    // 保存できなくても案内を閉じるだけはする
  }
  app.openObserverSetup(false);
}

function restoreObserver(): void {
  const observer = loadObserver();
  app.setObserver(observer);
  if (observer !== null) return;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(SETUP_DISMISSED_KEY) === '1';
  } catch {
    dismissed = false;
  }
  // 初回だけ案内する
  if (!dismissed) app.openObserverSetup(true);
}

// ---- 起動時の履歴取得 -------------------------------------------------

/**
 * /history には access-control-allow-origin: * が付いている（実測済み）ので
 * ブラウザから直接取れる。取れなかった場合は「接続後に届いたものだけ表示」に倒す。
 * レート制限があるので、起動時の1回以外でRESTを叩かない。
 */
async function fetchHistory(): Promise<void> {
  if (!config.fetchHistoryOnStart) {
    degradedReasons.add('起動時の履歴取得は無効');
    return;
  }
  const url = `${config.p2p.history}?codes=551&limit=20`;
  const sentAt = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    clock.addHttpSample(res.headers.get('date'), sentAt, Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = (await res.json()) as unknown[];
    const now = clock.now();
    for (const item of items.reverse()) {
      store.ingest(
        normalize({ source: 'p2p', payload: item, receivedAt: now }, now),
      );
    }
  } catch (err) {
    degradedReasons.add('起動時の履歴を取得できず（接続後の受信分のみ表示）');
    console.error('[main] history', err);
  }
  render();
}

/** Wolfxの現在値。WebSocketが繋がる前の空白を埋める */
async function fetchWolfxSnapshot(): Promise<void> {
  const sentAt = Date.now();
  try {
    const res = await fetch(config.wolfx.json, { cache: 'no-store' });
    clock.addHttpSample(res.headers.get('date'), sentAt, Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const now = clock.now();
    store.ingest(
      normalize({ source: 'wolfx', payload: await res.json(), receivedAt: now }, now),
    );
  } catch (err) {
    console.error('[main] wolfx snapshot', err);
  }
  render();
}

// ---- 再接続トリガと時刻補正 -------------------------------------------

window.addEventListener('online', () => {
  wolfx.reconnectNow('オンライン復帰');
  p2p.reconnectNow('オンライン復帰');
});
window.addEventListener('offline', () => {
  degradedReasons.add('オフライン');
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  degradedReasons.delete('オフライン');
  wolfx.reconnectNow('画面復帰');
  p2p.reconnectNow('画面復帰');
});

/**
 * 起動直後のサーバー時刻。
 *
 * 定常的な時刻推定はWolfxの pong（WebSocket）でやる。HTTPを叩くのはここ1回だけで、
 * WebSocketが繋がって最初の pong が返るまでの空白を埋めるためのもの。
 */
async function syncClock(): Promise<void> {
  await clock.sync(config.wolfx.json);
  render();
}

// ---- 起動 -------------------------------------------------------------

async function boot(): Promise<void> {
  render();
  restoreObserver();
  wolfx.start();
  p2p.start();
  await Promise.all([
    syncClock(),
    fetchWolfxSnapshot(),
    fetchHistory(),
    loadTravelTime(),
  ]);

  // 進行中のEEWは時間経過だけで終わる。1秒ごとに見直す
  window.setInterval(() => store.refresh(), 1_000);
  // これ以降の時刻推定はWolfxの pong（WebSocket）だけで回す。HTTPは叩かない
}

void boot();
