/**
 * 気象庁 JMA2001 走時表。
 *
 * 固定長フォーマット（空白区切りでも同じ結果になる）:
 *   01     A1     相名 P
 *   03-10  F8.3   P波走時 (sec)
 *   12     A1     相名 S
 *   14-21  F8.3   S波走時 (sec)
 *   23-25  I3     深さ (km)
 *   28-32  I5     震央距離 (km)
 *
 * 深さ 0〜700km、震央距離 0〜2000km。
 *
 * **この表が返すのは「震央距離」（地表に沿った距離）であって震源距離ではない。**
 * 地図に描く円の半径としてそのまま使える。深さで補正し直してはいけない。
 */

export interface TravelTimeRow {
  /** P波走時 (sec) */
  p: number;
  /** S波走時 (sec) */
  s: number;
  /** 深さ (km) */
  depth: number;
  /** 震央距離 (km) */
  distance: number;
}

export interface TravelTimeTable {
  /** 深さ → 震央距離昇順の行 */
  byDepth: ReadonlyMap<number, readonly TravelTimeRow[]>;
  /** 昇順の深さ一覧 */
  depths: readonly number[];
}

/** 震央距離 (km)。まだ地表に届いていない・範囲外なら null */
export interface WaveRadii {
  p: number | null;
  s: number | null;
}

type Phase = 'p' | 's';

export function parseTravelTimeTable(text: string): TravelTimeTable {
  const grouped = new Map<number, TravelTimeRow[]>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const t = trimmed.split(/\s+/);
    // [0]='P' [1]=P走時 [2]='S' [3]=S走時 [4]=深さ [5]=震央距離
    if (t.length < 6) continue;

    const p = Number(t[1]);
    const s = Number(t[3]);
    const depth = Number(t[4]);
    const distance = Number(t[5]);
    if (![p, s, depth, distance].every((v) => Number.isFinite(v))) continue;

    const rows = grouped.get(depth);
    if (rows) rows.push({ p, s, depth, distance });
    else grouped.set(depth, [{ p, s, depth, distance }]);
  }

  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.distance - b.distance);
  }
  const depths = [...grouped.keys()].sort((a, b) => a - b);

  return { byDepth: grouped, depths };
}

export async function loadTravelTimeTable(url: string): Promise<TravelTimeTable> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`走時表を取得できない: HTTP ${res.status}`);
  return parseTravelTimeTable(await res.text());
}

/**
 * 指定の深さ・経過秒数における P波・S波の震央距離。
 *
 * null になる場合を分けて扱うこと:
 *   - 経過秒数がその深さでの震央距離0kmの走時より小さい → まだ地表に届いていない
 *   - 経過秒数が表の最大走時を超える → 範囲外（実質2000km到達）
 *   - 深さが表の範囲外
 * いずれも「円を描かない」。0kmの円を描くのとは意味が違う。
 */
export function waveRadii(
  table: TravelTimeTable,
  depthKm: number,
  elapsedSec: number,
): WaveRadii {
  if (!Number.isFinite(depthKm) || !Number.isFinite(elapsedSec)) {
    return { p: null, s: null };
  }
  const bracket = bracketDepths(table, depthKm);
  if (bracket === null) return { p: null, s: null };

  return {
    p: radiusAtDepth(table, bracket, depthKm, elapsedSec, 'p'),
    s: radiusAtDepth(table, bracket, depthKm, elapsedSec, 's'),
  };
}

/** 走時 (sec)。表の外なら null */
export interface TravelTimes {
  p: number | null;
  s: number | null;
}

/**
 * 指定の深さ・震央距離における走時。waveRadii の逆引き。
 *
 * 到達予測のカウントダウンに使う。**予報円と同じ表・同じ補間**を通すので、
 * 「S円が地点に届いた瞬間に残り0」になり、地図と数字が食い違わない。
 *
 * 震央距離が表の外（2000km超）や深さが範囲外なら null。
 */
export function travelTimes(
  table: TravelTimeTable,
  depthKm: number,
  distanceKm: number,
): TravelTimes {
  if (!Number.isFinite(depthKm) || !Number.isFinite(distanceKm)) {
    return { p: null, s: null };
  }
  if (distanceKm < 0) return { p: null, s: null };
  const bracket = bracketDepths(table, depthKm);
  if (bracket === null) return { p: null, s: null };

  const at = (phase: Phase): number | null => {
    const lower = timeForDistance(table.byDepth.get(bracket.lower), distanceKm, phase);
    if (lower === null) return null;
    if (bracket.lower === bracket.upper) return lower;
    const upper = timeForDistance(table.byDepth.get(bracket.upper), distanceKm, phase);
    if (upper === null) return null;
    return interpolate(bracket.lower, lower, bracket.upper, upper, depthKm);
  };

  return { p: at('p'), s: at('s') };
}

/** その深さで、震央距離に対する走時。距離は昇順なので二分探索できる */
function timeForDistance(
  rows: readonly TravelTimeRow[] | undefined,
  distanceKm: number,
  phase: Phase,
): number | null {
  if (!rows || rows.length === 0) return null;
  const first = rows[0] as TravelTimeRow;
  const last = rows[rows.length - 1] as TravelTimeRow;
  if (distanceKm < first.distance) return null;
  // 表の外（2000km超）。外挿はしない
  if (distanceKm > last.distance) return null;

  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] as TravelTimeRow).distance <= distanceKm) lo = mid;
    else hi = mid;
  }
  const a = rows[lo] as TravelTimeRow;
  const b = rows[hi] as TravelTimeRow;
  return interpolate(a.distance, a[phase], b.distance, b[phase], distanceKm);
}

/**
 * 震央直上に波が到達するまでの秒数（＝予報円が出現するまでの待ち時間）。
 * 深い地震ほど円の出現が遅れる。
 */
export function surfaceArrivalDelay(
  table: TravelTimeTable,
  depthKm: number,
): WaveRadii {
  const bracket = bracketDepths(table, depthKm);
  if (bracket === null) return { p: null, s: null };

  const at = (phase: Phase): number | null => {
    const lower = firstRow(table, bracket.lower);
    const upper = firstRow(table, bracket.upper);
    if (lower === null || upper === null) return null;
    return interpolate(
      bracket.lower,
      lower[phase],
      bracket.upper,
      upper[phase],
      depthKm,
    );
  };
  return { p: at('p'), s: at('s') };
}

interface DepthBracket {
  lower: number;
  upper: number;
}

/** 指定の深さを挟む2つの深さ。完全一致ならその1つ。範囲外なら null */
function bracketDepths(table: TravelTimeTable, depthKm: number): DepthBracket | null {
  const { depths } = table;
  if (depths.length === 0) return null;
  const first = depths[0] as number;
  const last = depths[depths.length - 1] as number;
  if (depthKm < first || depthKm > last) return null;

  let lo = 0;
  let hi = depths.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = depths[mid] as number;
    if (v === depthKm) return { lower: v, upper: v };
    if (v < depthKm) lo = mid + 1;
    else hi = mid - 1;
  }
  // hi < lo。depths[hi] < depthKm < depths[lo]
  return { lower: depths[hi] as number, upper: depths[lo] as number };
}

function firstRow(table: TravelTimeTable, depth: number): TravelTimeRow | null {
  const rows = table.byDepth.get(depth);
  return rows && rows.length > 0 ? (rows[0] as TravelTimeRow) : null;
}

function radiusAtDepth(
  table: TravelTimeTable,
  bracket: DepthBracket,
  depthKm: number,
  elapsedSec: number,
  phase: Phase,
): number | null {
  const lower = distanceForTime(table.byDepth.get(bracket.lower), elapsedSec, phase);
  if (lower === null) return null;
  if (bracket.lower === bracket.upper) return lower;

  const upper = distanceForTime(table.byDepth.get(bracket.upper), elapsedSec, phase);
  // 片方の深さで求まらない（まだ届いていない／範囲外）なら、
  // 深さ方向に補間できない。描かないほうに倒す
  if (upper === null) return null;

  return interpolate(bracket.lower, lower, bracket.upper, upper, depthKm);
}

/**
 * その深さで、走時が elapsedSec になる震央距離。
 * 走時は震央距離に対して単調増加なので二分探索が使える。
 */
function distanceForTime(
  rows: readonly TravelTimeRow[] | undefined,
  elapsedSec: number,
  phase: Phase,
): number | null {
  if (!rows || rows.length === 0) return null;

  const first = rows[0] as TravelTimeRow;
  const last = rows[rows.length - 1] as TravelTimeRow;
  // まだ震央直上にも届いていない
  if (elapsedSec < first[phase]) return null;
  // 表の外（実質2000km到達）
  if (elapsedSec > last[phase]) return null;

  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] as TravelTimeRow)[phase] <= elapsedSec) lo = mid;
    else hi = mid;
  }

  const a = rows[lo] as TravelTimeRow;
  const b = rows[hi] as TravelTimeRow;
  return interpolate(a[phase], a.distance, b[phase], b.distance, elapsedSec);
}

/** (x0,y0)-(x1,y1) の線形補間。x0 === x1 なら y0 */
function interpolate(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x: number,
): number {
  if (x1 === x0) return y0;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
