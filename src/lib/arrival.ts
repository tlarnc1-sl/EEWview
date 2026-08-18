import type { EewEvent } from '../types';
import type { TravelTimeTable } from './travelTime';
import { travelTimes } from './travelTime';
import { isPlumMethod } from './waveCircles';
import { roundSource } from './intensityPrediction';
import { surfaceDistanceKm } from './geo';

/**
 * 主要動の到達予測。
 *
 * 予報円とまったく同じ走時表・同じ丸め・同じ補間を通す。
 * そうしないと「S円が地点に届いているのに残り5秒」のような食い違いが出て、
 * どちらが正しいのか分からなくなる。
 *
 * 精度と表示の刻みは別の話。時刻補正の分解能が±0.5秒、走時表の刻みが数km、
 * そして**震源要素の推定誤差がいちばん大きい**（第1報と最終報で震源が動く）ので、
 * 真の到達時刻とは±数秒ずれる。それでも**表示は0.1秒まで出す**。
 * 刻みを粗くしても誤差は減らないし、ここは公開しない個人用の計器で、
 * 秒未満を隠して得るものが無い。
 */

/**
 * 残りがこれ以下なら、差し迫っているものとして強く出す（地を赤で塗る）。
 *
 * 10秒。**身構えるのに要る時間**から決めた（火を止める・机の下に入る・
 * 頭を守る位置に移る）。3秒だと、赤くなってから何かする余地が無い。
 */
export const IMMINENT_SEC = 10;

/** 表示の刻み。1秒をこの数で割った単位まで出す（10 = 0.1秒） */
const STEPS_PER_SEC = 10;

export type ArrivalUnavailable =
  | 'plum'
  | 'no-hypocenter'
  | 'no-origin'
  | 'too-far'
  | 'no-site';

export interface ArrivalEstimate {
  /** 震央距離 (km) */
  distanceKm: number;
  /** 発震からの走時 (sec) */
  pTravelSec: number;
  sTravelSec: number;
  /** 到達予測時刻（epoch ms） */
  pAt: number;
  sAt: number;
  /** 残り秒数。負なら到達済み */
  pRemainSec: number;
  sRemainSec: number;
}

export type ArrivalResult =
  | { kind: 'ok'; arrival: ArrivalEstimate }
  | { kind: 'unavailable'; reason: ArrivalUnavailable };

export interface ArrivalSite {
  lat: number;
  lon: number;
}

/**
 * ある地点への到達予測。
 *
 * 深さで足切りしない（気象庁は深さ150km超で主要動到達予測を行わないが、
 * 走時表は700kmまで値を持ち、予報円も描いている。円と数字を揃える）。
 */
export function predictArrival(
  eew: EewEvent,
  site: ArrivalSite | null,
  table: TravelTimeTable,
  now: number,
): ArrivalResult {
  if (site === null) return { kind: 'unavailable', reason: 'no-site' };
  // PLUM法は震源を決めていない。震源からの走時は引けない。
  // 気象庁自身も「主要動到達時刻の予測なし（PLUM 法による予測）」と入れてくる
  if (isPlumMethod(eew)) return { kind: 'unavailable', reason: 'plum' };

  const { lat, lon, depthKm } = eew.hypocenter;
  if (lat === null || lon === null || depthKm === null) {
    return { kind: 'unavailable', reason: 'no-hypocenter' };
  }
  if (eew.originAt === null) return { kind: 'unavailable', reason: 'no-origin' };

  // 予報円・予測震度と同じ丸め（緯度経度0.1度・深さ10km）
  const source = roundSource({ lat, lon, depthKm, magnitude: 0 });
  const distanceKm = surfaceDistanceKm(source.lat, source.lon, site.lat, site.lon);
  const times = travelTimes(table, source.depthKm, distanceKm);
  if (times.p === null || times.s === null) {
    // 震央距離が表の外（2000km超）。外挿はしない
    return { kind: 'unavailable', reason: 'too-far' };
  }

  const pAt = eew.originAt + times.p * 1000;
  const sAt = eew.originAt + times.s * 1000;

  return {
    kind: 'ok',
    arrival: {
      distanceKm,
      pTravelSec: times.p,
      sTravelSec: times.s,
      pAt,
      sAt,
      pRemainSec: (pAt - now) / 1000,
      sRemainSec: (sAt - now) / 1000,
    },
  };
}

/**
 * 残りの表示。**0.1秒まで出す。**
 *
 * 走時と時刻補正から出る値なので、0.1秒の位まで意味のある数字が立つ
 * （震源要素の推定誤差で真の値は±数秒ずれるが、それは精度の話で、
 * 表示の刻みを粗くしても消えない）。公開しない個人用の計器なので、
 * 秒未満を隠して得るものが無い。
 *
 * 到達したら**0.0秒のまま止める**。経過秒数を数え上げないのはもちろん、
 * 「到達（推定）」のような文字にも変えない——数字が文字に化けると、
 * 桁も幅も組み方も変わって、同じ場所の同じ値には見えなくなる。
 * 0.0 は「もう残りが無い」を数字のまま言える。
 *
 * 数字を出せないのは値が取れないときだけ（NaN）。そこは「—」。
 *
 * 「あと 24.3秒」を1つの文字列にすると、大きく組んだとき桁数で枠から出るので、
 * 整数部と小数部を分けて組めるように数値で返す（splitSeconds）。
 * 刻みは0.1秒で、**切り上げる**ので、まだ届いていないのに 0.0 とは出ない。
 */
export type RemainDisplay =
  | { kind: 'count'; seconds: number }
  | { kind: 'text'; text: string };

export function remainDisplay(remainSec: number): RemainDisplay {
  if (!Number.isFinite(remainSec)) return { kind: 'text', text: '—' };
  // 到達したら0.0で止める。マイナスには行かせない
  if (remainSec <= 0) return { kind: 'count', seconds: 0 };
  /*
   * 0.1秒に切り上げる。**整数にしてから割る**こと。
   * 0.1 を掛けると 23.200000000000003 のような丸め残りが出る。
   */
  return {
    kind: 'count',
    seconds: Math.ceil(remainSec * STEPS_PER_SEC) / STEPS_PER_SEC,
  };
}

/** 整数部と小数部（"4" と ".3"）。大きさを変えて組むために分ける */
export function splitSeconds(seconds: number): { whole: string; frac: string } {
  const text = seconds.toFixed(1);
  const dot = text.indexOf('.');
  return { whole: text.slice(0, dot), frac: text.slice(dot) };
}

export function describeArrivalUnavailable(reason: ArrivalUnavailable): string {
  switch (reason) {
    case 'plum':
      return 'PLUM法（到達予測なし）';
    case 'no-hypocenter':
      return '震源が未確定';
    case 'no-origin':
      return '発震時刻が未確定';
    case 'too-far':
      return '震央距離が範囲外';
    case 'no-site':
      return '現在地が未設定';
  }
}

/**
 * 気象庁が地域ごとに出している到達予測時刻（WarnArea の Time、hhmmss）を
 * epoch ms にする。
 *
 * 日付は報の発表時刻から補う。日を跨ぐ場合（23:59発表・00:01到達）があるので、
 * 発表時刻より大きく前なら翌日として扱う。
 * "//////" のような埋め字は adapters 側で null にしてある。
 */
export function arrivalTimeFromRaw(
  raw: string | null,
  announcedAt: number | null,
): number | null {
  if (raw === null || announcedAt === null) return null;
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return null;

  const [, hh, mm, ss] = m;
  const base = new Date(announcedAt + 9 * 3600_000);
  const candidate = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    Number(hh),
    Number(mm),
    Number(ss),
  ) - 9 * 3600_000;

  // 発表より12時間以上前なら、日を跨いだ翌日の時刻とみなす
  if (candidate < announcedAt - 12 * 3600_000) return candidate + 24 * 3600_000;
  return candidate;
}
