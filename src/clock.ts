/**
 * サーバー時刻に対するクライアント時計のずれを推定する。
 *
 * ブラウザではNTPが使えない。端末の時計が数分ずれていることは普通にある。
 * 到達予測（次フェーズ）は当然として、接続品質の表示にも必要なので今のうちに作る。
 *
 * 推定方法:
 *   t0 = 送信時刻, t1 = 受信時刻, T = サーバー時刻とすると
 *   offset ≒ T + rtt/2 - t1
 * サンプルは中央値をとって外れ値を捨てる。
 *
 * 精度の限界: HTTPの Date ヘッダは秒単位なので、この方法での分解能は約±0.5秒。
 * 秒未満の精度が要る計算に使ってはいけない。
 */

export type ClockStatus =
  | 'unknown' // まだ推定できていない
  | 'ok'
  | 'suspect'; // ずれが大きすぎる。端末時計かネットワークがおかしい

/** これを超えるずれは「異常」として画面に出す */
const SUSPECT_OFFSET_MS = 120_000;
const MAX_SAMPLES = 9;

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
  at: number;
}

export class Clock {
  private samples: ClockSample[] = [];

  constructor(private readonly localNow: () => number = () => Date.now()) {}

  /**
   * 往復から1サンプル追加する。
   * @param serverTime サーバーが返した時刻（epoch ms）
   * @param sentAt 送信時のローカル時刻
   * @param receivedAt 受信時のローカル時刻
   */
  addSample(serverTime: number, sentAt: number, receivedAt: number): void {
    if (!Number.isFinite(serverTime)) return;
    const rttMs = receivedAt - sentAt;
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    // 往復が異常に長いサンプルは片道の推定が効かないので捨てる
    if (rttMs > 10_000) return;
    const offsetMs = serverTime + rttMs / 2 - receivedAt;
    this.samples.push({ offsetMs, rttMs, at: receivedAt });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** HTTPレスポンスの Date ヘッダから1サンプル追加する */
  addHttpSample(dateHeader: string | null, sentAt: number, receivedAt: number): void {
    if (!dateHeader) return;
    const t = Date.parse(dateHeader);
    if (!Number.isFinite(t)) return;
    // Date は秒単位に切り捨てられているので、半秒足して中心に寄せる
    this.addSample(t + 500, sentAt, receivedAt);
  }

  /** 推定オフセット（ミリ秒）。未推定なら null */
  get offsetMs(): number | null {
    if (this.samples.length === 0) return null;
    return median(this.samples.map((s) => s.offsetMs));
  }

  get rttMs(): number | null {
    if (this.samples.length === 0) return null;
    return median(this.samples.map((s) => s.rttMs));
  }

  get status(): ClockStatus {
    const offset = this.offsetMs;
    if (offset === null) return 'unknown';
    if (Math.abs(offset) > SUSPECT_OFFSET_MS) return 'suspect';
    return 'ok';
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * 補正済みの現在時刻。
   * 未推定ならローカル時計をそのまま返す（推定できないことは status で表に出す）。
   */
  now(): number {
    return this.localNow() + (this.offsetMs ?? 0);
  }

  /** HEADを1回投げてサーバー時刻を拾う。RESTのレート制限を食わない軽い呼び出し */
  async sync(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
    const sentAt = this.localNow();
    try {
      const res = await fetchFn(url, { method: 'HEAD', cache: 'no-store' });
      const receivedAt = this.localNow();
      this.addHttpSample(res.headers.get('date'), sentAt, receivedAt);
      return true;
    } catch {
      return false;
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
