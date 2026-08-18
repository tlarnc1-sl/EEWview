/**
 * 接続先の設定。
 *
 * 既定は**本番**。実際に今起きていることを見るためのアプリなので、
 * 既定が過去データだと「静かな画面」の意味が変わってしまう。
 *
 * 実装を試すときは VITE_P2P_ENV=sandbox でサンドボックスに切り替える。
 * 約30秒に1回、2023年のデータを配信してくる。WebSocketは10分で切られるので
 * 再接続の確認も同時にできる。
 */

export type P2pEnvironment = 'sandbox' | 'production';

export interface AppConfig {
  wolfx: {
    ws: string;
    /** フォールバック用。起動時に1回だけ叩く */
    json: string;
    heartbeatTimeoutMs: number;
  };
  p2p: {
    ws: string;
    history: string;
    environment: P2pEnvironment;
    /** WebSocketは10分で強制切断されるので、監視の間隔はそれより短く */
    heartbeatTimeoutMs: number;
  };
  /** 起動時に履歴を取りにいくか（CORSが無いなら false に倒す） */
  fetchHistoryOnStart: boolean;
}

const P2P_ENDPOINTS: Record<P2pEnvironment, { ws: string; history: string }> = {
  production: {
    ws: 'wss://api.p2pquake.net/v2/ws',
    history: 'https://api.p2pquake.net/v2/history',
  },
  sandbox: {
    ws: 'wss://api-realtime-sandbox.p2pquake.net/v2/ws',
    history: 'https://api-v2-sandbox.p2pquake.net/v2/history',
  },
};

function env(key: string): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string> };
  return meta.env?.[key];
}

function flag(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export function loadConfig(): AppConfig {
  const environment: P2pEnvironment =
    env('VITE_P2P_ENV') === 'sandbox' ? 'sandbox' : 'production';
  const p2p = P2P_ENDPOINTS[environment];

  return {
    wolfx: {
      ws: env('VITE_WOLFX_WS') ?? 'wss://ws-api.wolfx.jp/jma_eew',
      json: env('VITE_WOLFX_JSON') ?? 'https://api.wolfx.jp/jma_eew.json',
      // 毎分ハートビートが来るので、90秒無音なら死んだとみなす
      heartbeatTimeoutMs: 90_000,
    },
    p2p: {
      ws: env('VITE_P2P_WS') ?? p2p.ws,
      history: env('VITE_P2P_HISTORY') ?? p2p.history,
      environment,
      /*
       * P2Pはハートビートを送らない。届くのは地震情報と、不定期の各地域ピア数
       * （code 555）だけ。本番で実測したところ、接続してから最初の555まで
       * 3分以上空くことがあった。無音を根拠に切ると誤って繋ぎ直すので、
       * 監視は緩くとる。
       *
       * このため「p2pが受信中」は接続が生きている証明にならない。
       * 画面には最終受信時刻を出して、判断できるようにしてある。
       *
       * サンドボックスは10分で強制切断されるので、それより後ろに置いて
       * サーバー側の close を再接続の合図にする。
       */
      heartbeatTimeoutMs: environment === 'sandbox' ? 11 * 60_000 : 10 * 60_000,
    },
    // /history には access-control-allow-origin: * が付いている（実測済み）
    fetchHistoryOnStart: flag('VITE_FETCH_HISTORY', true),
  };
}
