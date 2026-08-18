import type {
  AdapterResult,
  EewEvent,
  EewAccuracy,
  EewWarnArea,
  Hypocenter,
} from '../types';
import { intensityFromJmaString } from './intensity';
import { parseJst } from '../util/jst';
import { arr, bool, isObject, num, obj, str } from '../util/pick';

/**
 * Wolfx (wss://ws-api.wolfx.jp/jma_eew) の生JSON → EewEvent。
 *
 * 公式のフィールド定義表は取得できていない。ここにあるのは実データから
 * 起こしたものなので、**未知のフィールドが来る前提**で読む。
 * 知らないフィールドは raw に残るだけで、パースは壊れない。
 */

/** 接続直後に投げ込まれる過去の報を新着扱いしないための閾値 */
export const HISTORICAL_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * 震源の確からしさ。ここに挙げた語が Accuracy.Epicenter に含まれる報、
 * および isAssumption の報では、震源に基づく計算をしてはいけない。
 * （次フェーズの到達予測・予測震度のためのフラグ）
 *
 * 文字列は配信元による和訳なので、生電文のコード（下記）が読めるならそちらを優先する。
 */
const UNRELIABLE_EPICENTER = ['PLUM', 'レベル', '未定', '不明', 'ＰＬＵＭ'];

export function isUnreliableEpicenter(accuracyEpicenter: string | null): boolean {
  if (!accuracyEpicenter) return true;
  return UNRELIABLE_EPICENTER.some((w) => accuracyEpicenter.includes(w));
}

/**
 * 生電文の RK フィールドから、震央の確からしさのコードを取り出す。
 *
 *   ... RK44559 RT01/// RC0//// ...
 *        ^ 1桁目が震央の確からしさ
 *
 * 気象庁の値: 0 不明・未定 / 1 IPF法(1点) / 2 IPF法(2点) / 3 IPF法(3-4点) /
 * 4 IPF法(5点以上) / 5 防災科研システム / 6 海洋研究開発機構 / 7 気象研究所 /
 * 8 予備 / **9 PLUM法**。
 *
 * 実データで確認済み: RK44559・RK44209 のどちらも1桁目が 4 で、
 * Accuracy.Epicenter は「IPF 法（5 点以上）」だった。
 * 埋め字（"/"）が入ることがあるので、数字でなければ null を返す。
 */
export function epicenterAccuracyCode(originalText: string | null): number | null {
  if (!originalText) return null;
  const m = /RK([0-9/]{5})/.exec(originalText);
  const c = m?.[1]?.[0];
  if (c === undefined || c < '0' || c > '9') return null;
  return Number(c);
}

/** PLUM法を表す震央の確からしさコード */
export const PLUM_ACCURACY_CODE = 9;

/** 確からしさコードのうち、震源に基づく計算に使ってよいもの（IPF法・各機関の震源） */
function isReliableAccuracyCode(code: number): boolean {
  return code >= 1 && code <= 7;
}

export interface WolfxAdapterOptions {
  receivedAt: number;
  /** 履歴判定に使う現在時刻（補正済みサーバー時刻を渡す） */
  now?: number;
}

export function parseWolfxMessage(
  payload: unknown,
  options: WolfxAdapterOptions,
): AdapterResult {
  const { receivedAt } = options;
  const now = options.now ?? receivedAt;

  let data: unknown = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return {
        kind: 'parse-failure',
        source: 'wolfx',
        receivedAt,
        reason: 'JSONとして読めない',
        raw: payload,
      };
    }
  }

  if (!isObject(data)) {
    return {
      kind: 'parse-failure',
      source: 'wolfx',
      receivedAt,
      reason: 'オブジェクトではない',
      raw: data,
    };
  }

  // ハートビート（毎分）と ping への応答。イベントではないので捨てる。
  // ただし接続が生きている証拠なので、transport 側では素通しさせている。
  const type = str(data, 'type');
  if (type === 'heartbeat' || type === 'pong') return null;
  if ('ping' in data) return null;

  // EEW以外の型が増えても壊れないよう、EventIDの有無で判定する
  const eventId = str(data, 'EventID');
  if (eventId === null) {
    // type が jma_eew でないなら未対応メッセージ。エラーではない
    if (type !== null && type !== 'jma_eew') return null;
    return {
      kind: 'parse-failure',
      source: 'wolfx',
      receivedAt,
      reason: 'EventIDが無い',
      raw: data,
    };
  }

  const announcedAt = parseJst(data['AnnouncedTime']);
  const originAt = parseJst(data['OriginTime']);

  const originalText = str(data, 'OriginalText');
  const epicenterCode = epicenterAccuracyCode(originalText);
  const accuracySrc = obj(data, 'Accuracy');
  const accuracy: EewAccuracy | null =
    accuracySrc || epicenterCode !== null
      ? {
          epicenter: str(accuracySrc, 'Epicenter'),
          depth: str(accuracySrc, 'Depth'),
          magnitude: str(accuracySrc, 'Magnitude'),
          epicenterCode,
        }
      : null;

  const hypocenter: Hypocenter = {
    name: str(data, 'Hypocenter'),
    lat: num(data, 'Latitude'),
    lon: num(data, 'Longitude'),
    depthKm: num(data, 'Depth'),
    // API側の綴り誤り。Magnitude ではなく Magunitude が正しいキー
    magnitude: num(data, 'Magunitude') ?? num(data, 'Magnitude'),
  };

  const isAssumption = bool(data, 'isAssumption');
  const epicenterReliable =
    !isAssumption &&
    hypocenter.lat !== null &&
    hypocenter.lon !== null &&
    // 電文のコードが読めればそちらで判定する。和訳の表記揺れに影響されない
    (epicenterCode !== null
      ? isReliableAccuracyCode(epicenterCode)
      : !isUnreliableEpicenter(accuracy?.epicenter ?? null));

  const event: EewEvent = {
    kind: 'eew',
    eventId,
    // Wolfxは数値、P2Pは文字列。ここで数値に揃える
    serial: num(data, 'Serial') ?? 0,
    receivedFrom: 'wolfx',
    receivedAt,
    announcedAt,
    originAt,
    hypocenter,
    maxIntensity: intensityFromJmaString(data['MaxIntensity']),
    title: str(data, 'Title'),
    isWarn: bool(data, 'isWarn'),
    isFinal: bool(data, 'isFinal'),
    isCancel: bool(data, 'isCancel'),
    isTraining: bool(data, 'isTraining'),
    isAssumption,
    isSea: bool(data, 'isSea'),
    accuracy,
    epicenterReliable,
    warnAreas: parseWarnAreas(arr(data, 'WarnArea')),
    // 生電文は必ず持ち回る（将来の検証に使う）
    originalText,
    raw: data,
    historical:
      announcedAt !== null && now - announcedAt > HISTORICAL_THRESHOLD_MS,
  };

  return event;
}

/**
 * ハートビート / pong に載っているサーバー時刻（epoch ms）を取り出す。
 *
 * 実測（本番、2026-08-16）:
 *   {"type":"heartbeat","ver":22,"id":"1824853","timestamp":1786879289030}
 *   {"type":"pong","timestamp":1786879289054}
 *
 * ブラウザではNTPが使えないので、これが唯一まともな時刻源になる。
 * ping への応答（pong）なら往復時間が分かるので、片道を差し引いて使える。
 * イベントではないものだけを対象にする（EEW本体の時刻はJST文字列で別物）。
 */
export function readWolfxServerTime(
  payload: unknown,
): { serverTime: number; isPong: boolean } | null {
  let data: unknown = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isObject(data)) return null;
  const type = str(data, 'type');
  if (type !== 'heartbeat' && type !== 'pong') return null;
  const serverTime = num(data, 'timestamp');
  // 桁が明らかにおかしい値（秒単位など）は使わない
  if (serverTime === null || serverTime < 1_000_000_000_000) return null;
  return { serverTime, isPong: type === 'pong' };
}

/**
 * 対象地域。実データのキーは Chiiki / Shindo1 / Shindo2 / Time / Type / Arrive。
 *
 * Time は "//////" が入ることがある（到達予測なし）。
 * 数字として読もうとせず、そのまま欠損として扱う。
 */
function parseWarnAreas(areas: unknown[]): EewWarnArea[] {
  const out: EewWarnArea[] = [];
  for (const a of areas) {
    if (typeof a === 'string') {
      out.push({ name: a, upper: null, lower: null, arrive: null, arriveTimeRaw: null });
      continue;
    }
    const name = str(a, 'Chiiki') ?? str(a, 'Name') ?? str(a, 'name');
    if (name === null) continue;

    const time = str(a, 'Time');
    out.push({
      name,
      upper: intensityFromJmaString(isObject(a) ? a['Shindo1'] : null),
      lower: intensityFromJmaString(isObject(a) ? a['Shindo2'] : null),
      arrive: str(a, 'Arrive'),
      // "//////" は「予測なし」の埋め字。時刻ではない
      arriveTimeRaw: time !== null && !time.includes('/') ? time : null,
    });
  }
  return out;
}
