import type { Intensity } from '../types';
import {
  predictIntensity,
  type IntensityPrediction,
  type PredictionSource,
} from './intensityPrediction';

/**
 * 震度観測点ごとの予測と、地域ごとの代表値。
 *
 * 気象庁は約4000点の震度観測点それぞれで震度を計算し、
 * **地域単位で最大値を代表として**発表している。ここはその再現。
 *
 * 観測点一覧（コード・名称・緯度経度・所属地域）と、各点の AVS30 を
 * 突き合わせた静的JSON（`public/assets/stations-avs30.json`）を読む。
 */

export interface AvsStation {
  name: string;
  code: string;
  lat: number;
  lon: number;
  pref: string | null;
  /** 所属する地域。地域の最大震度を出すときのキー */
  area: string | null;
  /**
   * 表層30m平均S波速度 (m/s)。引けなかった点は null。
   * J-SHISは水域（沿岸海域・湖沼・河道）で 0 を返す。これも「値なし」として扱う。
   */
  avs30: number | null;
  /** 微地形区分名。値がおかしいときの検証材料 */
  jname: string | null;
  /** 250mメッシュコード */
  mesh: string | null;
}

export interface StationsFile {
  source: Record<string, string>;
  stations: AvsStation[];
}

export interface StationPrediction {
  station: AvsStation;
  prediction: IntensityPrediction;
  /** 上限側（断層面までの最短距離）の震度階級 */
  intensity: Intensity;
}

export async function loadAvsStations(url: string): Promise<AvsStation[]> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`観測点データを取得できない: HTTP ${res.status}`);
  const file = (await res.json()) as StationsFile;
  return file.stations ?? [];
}

export interface StationPredictionResult {
  stations: StationPrediction[];
  /**
   * AVS30 が無くて計算できなかった観測点の数。
   * 0でなければ、その分だけ地図に穴が空いている。黙って埋めない。
   */
  skipped: number;
}

/** その観測点の AVS30 が使えるか。水域の 0 と欠測を弾く */
export function hasUsableAvs(station: AvsStation): boolean {
  return (
    station.avs30 !== null && Number.isFinite(station.avs30) && station.avs30 > 0
  );
}

/**
 * 全観測点について震度を予測する。
 *
 * AVS30 が無い点は**飛ばす**。増幅なし（基準基盤のまま）で埋めると、
 * 実際より小さい震度をその点だけ出すことになり、欠測より質が悪い。
 * J-SHISが水域で返す 0 も同じ扱い（(600/0)^0.66 は発散する）。
 */
export function predictStations(
  source: PredictionSource,
  stations: readonly AvsStation[],
): StationPredictionResult {
  const out: StationPrediction[] = [];
  let skipped = 0;

  for (const station of stations) {
    if (!hasUsableAvs(station)) {
      skipped += 1;
      continue;
    }
    const prediction = predictIntensity(source, {
      lat: station.lat,
      lon: station.lon,
      // hasUsableAvs を通っているので null ではない
      avs30: station.avs30 as number,
    });
    // 深さ150km超などで予測しない場合は、その地震について結果が空になる
    if (prediction === null) continue;
    out.push({ station, prediction, intensity: prediction.upper.intensity });
  }

  return { stations: out, skipped };
}

/**
 * 地域ごとの代表（最大）を取る。
 * 気象庁の発表と同じ単位にするための集約。
 */
export function maxByArea(
  results: readonly StationPrediction[],
): Map<string, StationPrediction> {
  const byArea = new Map<string, StationPrediction>();
  for (const r of results) {
    const area = r.station.area;
    if (area === null) continue;
    const current = byArea.get(area);
    if (
      current === undefined ||
      r.prediction.upper.measured > current.prediction.upper.measured
    ) {
      byArea.set(area, r);
    }
  }
  return byArea;
}

/** 予測の最大震度（全観測点のうち最も強い点）。1点も無ければ null */
export function maxStation(
  results: readonly StationPrediction[],
): StationPrediction | null {
  let best: StationPrediction | null = null;
  for (const r of results) {
    if (best === null || r.prediction.upper.measured > best.prediction.upper.measured) {
      best = r;
    }
  }
  return best;
}
