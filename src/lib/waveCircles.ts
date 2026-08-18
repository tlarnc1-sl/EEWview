import type { EewEvent } from '../types';
import type { TravelTimeTable } from './travelTime';
import { surfaceArrivalDelay } from './travelTime';
import { PLUM_ACCURACY_CODE } from '../adapters/wolfx';

/**
 * P波・S波の予報円を描いてよいかの判定。
 *
 * 描画レイヤの入口はここ1箇所。判定を各所に散らさない。
 *
 * **深さでは除外しない。PLUM法では描かない。**
 *   - 深発地震: 気象庁は深さ150km超で震度・主要動到達予測を行わないが、
 *     走時表は700kmまで値を持つので、波の到達そのものは描ける
 *   - PLUM法: そもそも震源を決める手法ではない。観測された揺れから
 *     その周辺の揺れを予測するもので、震源も発震時刻も確定していない。
 *     したがって「震源から広がる同心円」を描く根拠が無い。
 *     地図には震央の×印ではなく、位置が確からしくないことを示す円を出す。
 */

/**
 * 気象庁が緊急地震速報で震度・主要動到達予測を行わない深さ。
 *
 * 深さ150kmより深い地震で震度5弱以上が観測された事例がないことと、
 * 異常震域（震源から離れた場所が強く揺れる現象）を同心円モデルでは
 * 表現できないことによる。
 *
 * **予報円の描画には使っていない**（この深さでも円は描く）。
 * 予測震度の扱いを見直すときの手がかりとして残す。
 */
export const JMA_PREDICTION_DEPTH_LIMIT_KM = 150;

/**
 * PLUM法で推定された報か。
 *
 * 主に見るのは**生電文 RK の1桁目**（正規化後は `accuracy.epicenterCode`）。
 * 9 がPLUM法。配信元による和訳の表記に依存しない。
 * 電文が無い配信元のために、文字列（「PLUM 法」等、半角・全角）も併せて見る。
 *
 * 注意: 対象地域ごとの `Arrive`（「主要動到達時刻の予測なし（PLUM 法による予測）」）
 * は**地域ごとの予測手法**であって震源決定手法ではない。混同しないこと。
 *
 * 予報円を描くかの判定と、地図の震央マーカーの形の決定に使う。
 */
export function isPlumMethod(eew: EewEvent): boolean {
  if (eew.accuracy?.epicenterCode === PLUM_ACCURACY_CODE) return true;
  const epicenter = eew.accuracy?.epicenter ?? null;
  if (epicenter === null) return false;
  return epicenter.includes('PLUM') || epicenter.includes('ＰＬＵＭ');
}

/**
 * 予報円を描くか。
 *
 * 描かないのは、取消報と、円を置く場所や基準時刻が無い場合だけ。
 * 予報・警報の区別は判定に混ぜない（どちらでも描く）。
 */
export function shouldDrawWaveCircles(eew: EewEvent): boolean {
  // 取消報は該当地震の円を即座に消す
  if (eew.isCancel) return false;

  // PLUM法は震源を決める手法ではない。震源から広がる波として描けない
  if (isPlumMethod(eew)) return false;

  // 震源の位置と発震時刻が無ければ、円を置く場所も基準時刻も無い
  if (eew.hypocenter.lat === null || eew.hypocenter.lon === null) return false;
  if (eew.originAt === null) return false;

  const depth = eew.hypocenter.depthKm;
  if (depth === null || !Number.isFinite(depth)) return false;

  return true;
}

/**
 * S波が震央直上に出てくるまでの待ち時間の進み具合。
 *
 * 深い地震では、発震から数十秒のあいだ**円が1つも無い**。
 * 波は震源から上がってきている途中で、地表にはまだ出ていないためで、
 * このとき地図に何も無いと「まだ何も起きていない」と読めてしまう。
 * 震央の印のまわりにこの進み具合を出して、待ちであることを示す。
 *
 * **見るのはS波だけ**（発震 → S波が震央直上に出るまでを一本で数える）。
 * 被害を出すのは主要動で、P波の到達はその途中の目印にすぎない。
 * 2段階にすると、リングが途中で一度満ちて数え直すので、
 * 「何が満ちようとしているのか」がかえって読めなくなる。
 *
 * 進み具合が1になった瞬間にS波の予報円が生まれる（同じ走時表・同じ深さで
 * 引いているので、リングの完了と円の出現は必ず一致する）。
 * 出たあとは円そのものが状態を語るので、リングは出さない（null）。
 */
export interface SurfaceStatus {
  /** 0〜1 */
  progress: number;
  /** S波が震央直上に出るまでの残り秒数 */
  remainSec: number;
}

export function surfaceStatus(
  table: TravelTimeTable,
  depthKm: number,
  elapsedSec: number,
): SurfaceStatus | null {
  if (!Number.isFinite(elapsedSec)) return null;
  const delay = surfaceArrivalDelay(table, depthKm);
  if (delay.s === null) return null;
  // 地表に出た。ここからは円が状態を語る
  if (elapsedSec >= delay.s) return null;

  return {
    progress: ratio(elapsedSec, 0, delay.s),
    remainSec: delay.s - elapsedSec,
  };
}

/** 0→to の中での位置。幅が無いなら 1 */
function ratio(value: number, from: number, to: number): number {
  if (to <= from) return 1;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}
