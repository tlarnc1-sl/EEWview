import type { Intensity } from '../types';
import { intensityFromMeasured } from '../adapters/intensity';
import { surfaceDistanceKm } from './geo';

/**
 * 震度予測（4段）。
 *
 * 式はすべて気象庁「緊急地震速報検討委員会 資料2-1（平成20年3月18日）」に
 * 記載のもの。出典は各定数のコメントに残す。
 *
 *   第0段 マグニチュード変換  Mw = Mjma − 0.171
 *   第1段 断層面までの最短距離 X
 *   第2段 基準基盤（Vs=600m/s）上の最大速度 PGV600  司・翠川(1999)
 *   第3段 地盤増幅                                   松岡・翠川(1994)
 *   第4段 計測震度への換算                           翠川ほか(1999)
 *
 * 精度の目安（気象庁の評価）: 予測と観測の一致は21%、±1階級以内が75%。
 * 式の標準偏差（増幅度 ±0.16 log、計測震度換算 ±0.21）に震源要素の推定誤差が
 * 乗るので、**階級1つ分のずれは常態**。
 */

/** 宇津(1982)・佐藤ほか(1989)。気象庁が採用している変換 */
const MJMA_TO_MW_OFFSET = 0.171;

/** 宇津(2001) の相似則 log10 L = 0.5 Mw − 1.85（Lはkm） */
const FAULT_LENGTH_A = 0.5;
const FAULT_LENGTH_B = 1.85;

/**
 * 最短距離の下限 (km)。
 * 断層長の半分より内側の地点では R − L/2 が0や負になるのでクリップする。
 * 気象庁の現行パラメータ設定は3km（仕様上は3〜5kmで設定可能）。
 */
const MIN_DISTANCE_KM = 3;

/** 基準基盤のS波速度 (m/s)。PGV600 の「600」 */
export const REFERENCE_VS = 600;

/** 松岡・翠川(1994) の速度増幅度の指数 */
const AMPLIFICATION_EXPONENT = 0.66;

/**
 * 震度予測を行わない深さ (km)。
 *
 * 距離減衰式が同心円状の分布しか作れず異常震域を表現できないこと、
 * 過去に深さ150kmより深い地震で震度5弱以上を観測した事例がないこと
 * （最深例は2006年6月12日の大分県中部、深さ145km）による。
 */
export const MAX_PREDICTION_DEPTH_KM = 150;

/**
 * 第4段の回帰が対象とした計測震度の下限。
 * 翠川ほか(1999)は**震度4以上**を対象に回帰されており、
 * これ未満の予測値は精度が保証されない。
 */
const REGRESSION_MIN_INTENSITY = 3.5;

/** 第2段の距離減衰式が想定する深さの上限 (km)。これを超えると過大に出る */
const ATTENUATION_DEPTH_LIMIT_KM = 50;

export interface PredictionSource {
  lat: number;
  lon: number;
  /** 深さ (km) */
  depthKm: number;
  /** 気象庁マグニチュード */
  magnitude: number;
}

export interface PredictionSite {
  lat: number;
  lon: number;
  /**
   * 地表から地下30mまでの平均S波速度 (m/s)。
   * 省略すると増幅なし（基準基盤そのもの）として扱う。
   */
  avs30?: number;
}

export interface PredictionBound {
  /** 基準基盤（Vs=600m/s）上の最大速度 (cm/s) */
  pgv600: number;
  /** 地表の最大速度 (cm/s) */
  pgv: number;
  /** 計測震度 */
  measured: number;
  /** 震度階級 */
  intensity: Intensity;
  /** 距離減衰式に入れた距離 (km) */
  distanceKm: number;
}

export interface IntensityPrediction {
  /** モーメントマグニチュード */
  mw: number;
  /** 断層長 (km) */
  faultLengthKm: number;
  /** 震央距離 (km) */
  epicentralDistanceKm: number;
  /** 震源距離 (km)。点震源としての距離 */
  hypocentralDistanceKm: number;
  /** 断層面までの最短距離を使った側。気象庁の発表では**上限** */
  upper: PredictionBound;
  /** 点震源の距離を使った側。気象庁の発表では**下限** */
  lower: PredictionBound;
  /** 地盤増幅率（基準基盤比） */
  amplification: number;
  /**
   * 第4段の回帰範囲（震度4以上）を下回るか。
   * true の値をそのまま出すと誤差が大きい。
   */
  belowRegressionRange: boolean;
  /** 第2段の距離減衰式が想定する深さ（50km以浅）を超えるか */
  beyondAttenuationDepth: boolean;
}

/**
 * 震源要素を気象庁の内部処理と同じ粒度に丸める。
 *
 * 緯度・経度0.1度、深さ10km（ただし0kmはなし）。
 * 報ごとに深さが1km単位で微動すると予測震度が跳ね、それが「遅れ発表」の
 * 原因になるため気象庁が導入した措置。同じ丸めを入れると挙動が近づく。
 */
export function roundSource(source: PredictionSource): PredictionSource {
  return {
    lat: Math.round(source.lat * 10) / 10,
    lon: Math.round(source.lon * 10) / 10,
    // 0km は無いので、10km を下限にする
    depthKm: Math.max(10, Math.round(source.depthKm / 10) * 10),
    magnitude: source.magnitude,
  };
}

/** 第0段。距離減衰式がモーメントマグニチュードを引数に取るための変換 */
export function toMomentMagnitude(mjma: number): number {
  return mjma - MJMA_TO_MW_OFFSET;
}

/** 相似則から断層長 (km) を出す */
export function faultLengthKm(mw: number): number {
  return 10 ** (FAULT_LENGTH_A * mw - FAULT_LENGTH_B);
}

/**
 * 第1段。断層面までの最短距離 (km)。
 *
 * EEWの発表タイミングでは断層走向が特定できないため、気象庁は震源を中心とした
 * 半径 L/2 の球で断層面を代用している。
 */
export function shortestDistanceKm(hypocentralKm: number, mw: number): number {
  return Math.max(hypocentralKm - faultLengthKm(mw) / 2, MIN_DISTANCE_KM);
}

/**
 * 第2段。司・翠川(1999) の最大速度距離減衰式。
 * 返すのは基準基盤（Vs=600m/s相当の硬質地盤）上の最大速度 (cm/s)。
 * 水平動2成分のうち大きい方に相当する。
 *
 * 定数 −1.29 は断層タイプ平均。原論文の断層タイプ別補正は気象庁の運用では使わない。
 * 0.0028·10^(0.5Mw) は震源近傍の飽和項で、近距離での発散を防ぐ。
 */
export function pgv600(mw: number, depthKm: number, distanceKm: number): number {
  const saturation = 0.0028 * 10 ** (0.5 * mw);
  const log =
    0.58 * mw +
    0.0038 * depthKm -
    1.29 -
    Math.log10(distanceKm + saturation) -
    0.002 * distanceKm;
  return 10 ** log;
}

/**
 * 第3段。松岡・翠川(1994) の速度増幅度。
 *
 * log10(ARV) = 1.83 − 0.66 log10(AVS)（100 < AVS < 1500、標準偏差 ±0.16）の
 * 比を取ると、基準基盤600m/s に対する増幅率は (600/AVS30)^0.66 になる。
 * 気象庁の資料にある「600→700 に 0.90 を掛けてから Vs=700 基準の増幅率」も
 * (600/700)^0.66 = 0.903 のことなので、まとめると同じ値になる。
 */
export function amplificationFromAvs30(avs30: number): number {
  if (!Number.isFinite(avs30) || avs30 <= 0) return 1;
  return (REFERENCE_VS / avs30) ** AMPLIFICATION_EXPONENT;
}

/**
 * J-SHIS V4 の ARV は工学的基盤 Vs=400m/s 基準なので、
 * 基準基盤600m/s 基準に直す。AVS30 が取れるならそちらを使うほうが一貫する。
 */
export function arv400ToReference(arv400: number): number {
  return arv400 * (REFERENCE_VS / 400) ** AMPLIFICATION_EXPONENT;
}

/** 第4段。翠川ほか(1999)。PGV は地表の最大速度 (cm/s)、標準偏差 ±0.21 */
export function measuredIntensity(pgv: number): number {
  return 2.68 + 1.72 * Math.log10(pgv);
}

export interface PredictOptions {
  /** 気象庁と同じ粒度に震源要素を丸めるか。既定は丸める */
  round?: boolean;
  /** 増幅率を直接与える（基準基盤600m/s比）。site.avs30 より優先する */
  amplification?: number;
}

/**
 * ある地点の震度を予測する。
 *
 * 深さが150kmを超える場合は予測しない（null）。
 * 気象庁も同じ範囲で震度予測を行わない運用にしている。
 */
export function predictIntensity(
  source: PredictionSource,
  site: PredictionSite,
  options: PredictOptions = {},
): IntensityPrediction | null {
  const values = [source.lat, source.lon, source.depthKm, source.magnitude, site.lat, site.lon];
  if (!values.every((v) => Number.isFinite(v))) return null;

  const src = options.round === false ? source : roundSource(source);
  if (src.depthKm > MAX_PREDICTION_DEPTH_KM) return null;

  const mw = toMomentMagnitude(src.magnitude);
  const length = faultLengthKm(mw);
  const epicentral = surfaceDistanceKm(src.lat, src.lon, site.lat, site.lon);
  const hypocentral = Math.hypot(epicentral, src.depthKm);
  const shortest = shortestDistanceKm(hypocentral, mw);

  const amplification =
    options.amplification ??
    (site.avs30 === undefined ? 1 : amplificationFromAvs30(site.avs30));

  const bound = (distanceKm: number): PredictionBound => {
    const base = pgv600(mw, src.depthKm, distanceKm);
    const pgv = base * amplification;
    const measured = measuredIntensity(pgv);
    return {
      pgv600: base,
      pgv,
      measured,
      intensity: intensityFromMeasured(measured),
      distanceKm,
    };
  };

  // 断層面までの最短距離が上限、点震源の距離が下限。
  // 気象庁はこの2つで「震度○○から○○」の形にしている
  const upper = bound(shortest);
  const lower = bound(hypocentral);

  return {
    mw,
    faultLengthKm: length,
    epicentralDistanceKm: epicentral,
    hypocentralDistanceKm: hypocentral,
    upper,
    lower,
    amplification,
    belowRegressionRange: upper.measured < REGRESSION_MIN_INTENSITY,
    beyondAttenuationDepth: src.depthKm > ATTENUATION_DEPTH_LIMIT_KM,
  };
}

/**
 * 気象庁の発表と同じ形（「震度○○」または「震度○○から○○」）にする。
 * 上限と下限が同じ階級なら一点表示になる。
 */
export function formatPredictionRange(prediction: IntensityPrediction): string {
  const { upper, lower } = prediction;
  if (upper.intensity.value === lower.intensity.value) return upper.intensity.label;
  return `${lower.intensity.label}から${upper.intensity.label}`;
}
