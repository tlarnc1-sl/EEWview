/**
 * 正規化イベントの型定義。
 *
 * UI層はこの型しか見ない。生JSONに触れてよいのは adapters/ だけ。
 * 将来 DMDATA.JP に移行するときは adapters/ を差し替える。
 */

export type SourceId = 'wolfx' | 'p2p';

/** 震度。数値はソート用、ラベルは表示用。46（5弱以上）のために両方要る。 */
export interface Intensity {
  /** 気象庁の震度階級コード（10=1, 45=5弱, 46=5弱以上, 70=7） */
  value: number;
  /** 表示ラベル（"5弱" / "5弱以上"） */
  label: string;
}

/**
 * 震源。各要素は独立に欠損しうる。
 * 「震源が丸ごと無い報」も「深さだけ無い報」も実在するので、
 * 欠けている要素は個別に null にする。
 */
export interface Hypocenter {
  name: string | null;
  /** 度。南半球の遠地地震では負になる（負＝欠損ではない） */
  lat: number | null;
  lon: number | null;
  /** km。0 は「ごく浅い」であって不明ではない */
  depthKm: number | null;
  magnitude: number | null;
}

export const EMPTY_HYPOCENTER: Hypocenter = {
  name: null,
  lat: null,
  lon: null,
  depthKm: null,
  magnitude: null,
};

/** 震源の位置が確定しているか（次フェーズの到達予測の前提条件） */
export function hasEpicenter(h: Hypocenter): boolean {
  return h.lat !== null && h.lon !== null;
}

/**
 * 緊急地震速報（気象庁発表）の正規化形。
 * 取得元は Wolfx 一本。P2Pの556（警報）は取らない（adapters/p2p.ts のコメント参照）。
 */
export interface EewEvent {
  kind: 'eew';
  /** 気象庁 EventID。Wolfx / P2P で一致する */
  eventId: string;
  /** 報番号。P2Pは文字列で来るので数値に揃える */
  serial: number;
  receivedFrom: SourceId;
  /** クライアント受信時刻（epoch ms） */
  receivedAt: number;
  /** 発表時刻（epoch ms, JST解釈済み） */
  announcedAt: number | null;
  /** 発震時刻（epoch ms, JST解釈済み） */
  originAt: number | null;
  hypocenter: Hypocenter;
  maxIntensity: Intensity | null;
  /** 気象庁が付けたタイトル。表示にはこれをそのまま使う */
  title: string | null;
  isWarn: boolean;
  isFinal: boolean;
  isCancel: boolean;
  isTraining: boolean;
  /** 仮定震源要素（PLUM法等）。true なら震源に基づく計算をしてはいけない */
  isAssumption: boolean;
  isSea: boolean;
  accuracy: EewAccuracy | null;
  /**
   * 震源の確からしさ。false のとき、震源に基づく計算（到達予測・予測震度）を
   * してはいけない。次フェーズのためのフラグで、今は表示にのみ使う。
   */
  epicenterReliable: boolean;
  /** 対象地域（気象庁の発表内容そのもの）。予報の段階では空 */
  warnAreas: EewWarnArea[];
  /** 生電文。将来の検証のために必ず持ち回る */
  originalText: string | null;
  /** 受信した生JSON */
  raw: unknown;
  /**
   * 接続直後に投げ込まれた過去の報。
   * true のものでUIを緊急表示にしてはいけない。
   */
  historical: boolean;
}

/**
 * 対象地域ごとの予測。実データ（Wolfx WarnArea）から起こしたもの。
 *
 *   { "Chiiki": "栃木県南部", "Shindo1": "5弱", "Shindo2": "5弱",
 *     "Time": "100639", "Type": "警報",
 *     "Arrive": "主要動到達時刻の予測なし（PLUM 法による予測）" }
 */
export interface EewWarnArea {
  name: string;
  /**
   * 予測震度の範囲。実データでは Shindo1 が上限、Shindo2 が下限
   * （埼玉県北部が Shindo1: "4" / Shindo2: "3"）。
   * ただし両者が入れ替わっていても壊れないよう、表示側は強いほうを採る。
   */
  upper: Intensity | null;
  lower: Intensity | null;
  /**
   * 主要動の到達についての気象庁の文言。
   * 「既に到達と予測」「主要動到達時刻の予測なし（PLUM 法による予測）」など。
   * そのまま表示する。
   */
  arrive: string | null;
  /**
   * 到達予測時刻の生値（hhmmss）。"//////" は予測なしを表すので null にする。
   * 次フェーズの到達予測で使う。ここでは時刻に組み立てない
   * （日付が入っておらず、日跨ぎの解釈をこの層で決めたくない）。
   */
  arriveTimeRaw: string | null;
}

export interface EewAccuracy {
  epicenter: string | null;
  depth: string | null;
  magnitude: string | null;
  /**
   * 震央の確からしさのコード（生電文 RK の1桁目）。
   * 文字列は配信元による和訳なので、判定にはこちらを使う。
   *   0 不明・未定 / 1-4 IPF法（点数別）/ 5 防災科研 /
   *   6 海洋研究開発機構 / 7 気象研究所 / 8 予備 / 9 PLUM法
   * 電文が無ければ null。
   */
  epicenterCode: number | null;
}

/** 地震情報（P2P code 551）の発表種別 */
export type QuakeIssueType =
  | 'ScalePrompt' // 震度速報：震源なし、区域別の震度あり
  | 'Destination' // 震源に関する情報：震源のみ、points 空
  | 'DetailScale' // 各地の震度：震源・観測点別震度あり
  | 'Foreign' // 遠地地震：震源のみ、points 空
  | 'Other';

export interface QuakePoint {
  /** 観測点名（isArea=false）または区域名（isArea=true） */
  addr: string;
  pref: string;
  isArea: boolean;
  intensity: Intensity | null;
}

/** 地震情報の正規化形 */
export interface QuakeInfoEvent {
  kind: 'quake';
  /** 配信元のレコードID（重複排除に使う） */
  id: string;
  receivedFrom: SourceId;
  receivedAt: number;
  issueType: QuakeIssueType;
  /** 気象庁の発表時刻 */
  issuedAt: number | null;
  /**
   * 同一地震の識別キー。P2Pの地震情報にはEventIDが無いので
   * earthquake.time の生文字列をそのまま使う。
   */
  quakeKey: string;
  /** 発震時刻（epoch ms） */
  occurredAt: number | null;
  hypocenter: Hypocenter;
  maxIntensity: Intensity | null;
  domesticTsunami: string | null;
  foreignTsunami: string | null;
  points: QuakePoint[];
  freeFormComment: string | null;
  raw: unknown;
  historical: boolean;
}

/** 津波予報（P2P code 552） */
export interface TsunamiEvent {
  kind: 'tsunami';
  id: string;
  receivedFrom: SourceId;
  receivedAt: number;
  issuedAt: number | null;
  /** 解除報 */
  cancelled: boolean;
  areas: TsunamiArea[];
  raw: unknown;
  historical: boolean;
}

export interface TsunamiArea {
  name: string;
  /** 気象庁の階級（MajorWarning / Warning / Watch / Unknown） */
  grade: string;
  /** 直ちに来襲する見込み */
  immediate: boolean;
  /** 予想される高さ（気象庁の文言。「１０ｍ超」など） */
  maxHeight: string | null;
  /** 第一波の到達予想時刻（epoch ms） */
  arrivalAt: number | null;
  /** 「津波到達中と推測」などの状況。時刻の代わりに入ることがある */
  condition: string | null;
}

export type NormalizedEvent = EewEvent | QuakeInfoEvent | TsunamiEvent;

/** パースできなかった生メッセージ。握り潰さず、この形で上げる */
export interface ParseFailure {
  kind: 'parse-failure';
  source: SourceId;
  receivedAt: number;
  reason: string;
  raw: unknown;
}

export type AdapterResult = NormalizedEvent | ParseFailure | null;
