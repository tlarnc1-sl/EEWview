import type { EewEvent } from '../types';
import { isPlumMethod } from './waveCircles';
import {
  predictIntensity,
  type IntensityPrediction,
  type PredictionSite,
} from './intensityPrediction';

/**
 * 進行中のEEWから、ある1地点の震度を予測する。
 *
 * 予測できない場合は理由を返す。「出ない」だけだと、
 * 揺れないのか計算できていないのかが区別できなくなる。
 */

export type UnavailableReason =
  | 'cancel'
  | 'plum'
  | 'no-hypocenter'
  | 'no-magnitude'
  | 'too-deep'
  | 'no-ground';

export type EewSitePrediction =
  | { kind: 'ok'; prediction: IntensityPrediction }
  | { kind: 'unavailable'; reason: UnavailableReason };

export function predictForEew(
  eew: EewEvent,
  site: PredictionSite,
): EewSitePrediction {
  if (eew.isCancel) return { kind: 'unavailable', reason: 'cancel' };

  // PLUM法は震源を決めていない。震源と規模に基づく距離減衰式は使えない
  if (isPlumMethod(eew)) return { kind: 'unavailable', reason: 'plum' };

  const { lat, lon, depthKm, magnitude } = eew.hypocenter;
  if (lat === null || lon === null || depthKm === null) {
    return { kind: 'unavailable', reason: 'no-hypocenter' };
  }
  if (magnitude === null) return { kind: 'unavailable', reason: 'no-magnitude' };
  if (site.avs30 === undefined || site.avs30 === null || site.avs30 <= 0) {
    return { kind: 'unavailable', reason: 'no-ground' };
  }

  const prediction = predictIntensity({ lat, lon, depthKm, magnitude }, site);
  // 深さ150km超では気象庁も震度予測を行わない
  if (prediction === null) return { kind: 'unavailable', reason: 'too-deep' };

  return { kind: 'ok', prediction };
}

/**
 * 予測できない理由。値の位置に置くので、「計算できません」は繰り返さない。
 * 出ていないことは見れば分かる。要るのは理由だけ。
 */
export function describeUnavailable(reason: UnavailableReason): string {
  switch (reason) {
    case 'cancel':
      return '取消';
    case 'plum':
      return 'PLUM法（震源なし）';
    case 'no-hypocenter':
      return '震源が未確定';
    case 'no-magnitude':
      return '規模が未確定';
    case 'too-deep':
      return '深さ150km超';
    case 'no-ground':
      return '地盤データなし';
  }
}
