import type {
  AdapterResult,
  Hypocenter,
  QuakeInfoEvent,
  QuakeIssueType,
  QuakePoint,
  TsunamiArea,
  TsunamiEvent,
} from '../types';
import { intensityFromScale } from './intensity';
import { parseJst } from '../util/jst';
import { arr, bool, isObject, num, numSentinel, obj, str } from '../util/pick';
import { HISTORICAL_THRESHOLD_MS } from './wolfx';

/**
 * P2P地震情報 API v2 の生JSON → 正規化イベント。
 *
 * 扱うコード: 551(地震情報) / 552(津波予報)
 * 無視するコード: 554・556(EEW) / 555(ピア数) / 561(感知情報) / 9611(感知情報解析)
 *
 * EEWはWolfx一本にしている。P2Pの556は警報級しか流れてこないうえ、
 * 経路が2つあると先着の採用や重複の始末が要る。取るのをやめて簡単にした。
 * （Wolfxが落ちている間はEEWが来なくなる。接続状態の表示で判断すること）
 *
 * 仕様に無いフィールドが実在し（timestamp, user_agent, ver, created_at）、
 * 仕様にあるフィールドが欠けることもある（comments は2024年データでは null）。
 * すべてオプショナル前提で読む。
 */

/** 震源の欠損センチネル。緯度経度は -200、深さ・マグニチュードは -1 */
const LATLON_SENTINEL = -200;
const NUMERIC_SENTINEL = -1;

export interface P2pAdapterOptions {
  receivedAt: number;
  /** 履歴判定に使う現在時刻（補正済みサーバー時刻を渡す） */
  now?: number;
}

export function parseP2pMessage(
  payload: unknown,
  options: P2pAdapterOptions,
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
        source: 'p2p',
        receivedAt,
        reason: 'JSONとして読めない',
        raw: payload,
      };
    }
  }

  if (!isObject(data)) {
    return {
      kind: 'parse-failure',
      source: 'p2p',
      receivedAt,
      reason: 'オブジェクトではない',
      raw: data,
    };
  }

  const code = num(data, 'code');
  if (code === null) {
    return {
      kind: 'parse-failure',
      source: 'p2p',
      receivedAt,
      reason: 'codeが無い',
      raw: data,
    };
  }

  // 配信時刻。サンドボックスは過去のデータを「今」配信するので、
  // 履歴判定には発表時刻ではなくこの配信時刻を使う。
  const distributedAt = parseJst(data['time']);
  const historical =
    distributedAt !== null && now - distributedAt > HISTORICAL_THRESHOLD_MS;

  switch (code) {
    case 551:
      return parseQuakeInfo(data, receivedAt, historical);
    case 552:
      return parseTsunami(data, receivedAt, historical);
    default:
      // 554 / 556（EEW）・555 / 561 / 9611 とそれ以外は黙って捨てる。
      // エラーではない
      return null;
  }
}

/** 一意なレコードID。無ければ time+code から作る（重複排除のキーになる） */
function recordId(data: Record<string, unknown>, code: number): string {
  return str(data, 'id') ?? `${code}:${str(data, 'time') ?? 'unknown'}`;
}

/**
 * 震源を読む。
 *
 * 欠損センチネルは**フィールドごとに独立**している。
 * - 震度速報: 震源が丸ごと無い（lat/lon = -200, depth/magnitude = -1, name = ""）
 * - 遠地地震: 震源はあるが深さだけ無い（depth = -1、lat は南半球なら負の正当値）
 *
 * したがって latitude は -200 との**厳密比較**で判定する。
 * `latitude < 0` で判定すると南半球の地震を落とす。
 */
export function parseHypocenter(src: unknown): Hypocenter {
  const h = isObject(src) ? src : null;
  if (!h) return { name: null, lat: null, lon: null, depthKm: null, magnitude: null };

  const lat = numSentinel(h, 'latitude', LATLON_SENTINEL);
  const lon = numSentinel(h, 'longitude', LATLON_SENTINEL);

  return {
    name: str(h, 'name'),
    // 緯度と経度は組で有効。片方だけ有効な報は震源なしとして扱う
    lat: lat !== null && lon !== null ? lat : null,
    lon: lat !== null && lon !== null ? lon : null,
    // depth: 0 は「ごく浅い」であって不明ではない。-1 だけを欠損とする
    depthKm: numSentinel(h, 'depth', NUMERIC_SENTINEL),
    magnitude: numSentinel(h, 'magnitude', NUMERIC_SENTINEL),
  };
}

const ISSUE_TYPES: ReadonlySet<string> = new Set([
  'ScalePrompt',
  'Destination',
  'DetailScale',
  'Foreign',
]);

function issueType(issue: Record<string, unknown> | null): QuakeIssueType {
  const t = str(issue, 'type');
  if (t !== null && ISSUE_TYPES.has(t)) return t as QuakeIssueType;
  return 'Other';
}

function parseQuakeInfo(
  data: Record<string, unknown>,
  receivedAt: number,
  historical: boolean,
): QuakeInfoEvent {
  const issue = obj(data, 'issue');
  const earthquake = obj(data, 'earthquake');

  // P2Pの地震情報にはEventIDが無い。発震時刻の生文字列を同一地震のキーにする
  const quakeKey = str(earthquake, 'time') ?? recordId(data, 551);

  return {
    kind: 'quake',
    id: recordId(data, 551),
    receivedFrom: 'p2p',
    receivedAt,
    issueType: issueType(issue),
    issuedAt: parseJst(issue?.['time']),
    quakeKey,
    occurredAt: parseJst(earthquake?.['time']),
    hypocenter: parseHypocenter(earthquake?.['hypocenter']),
    // maxScale は -1（震度情報なし）がある。Destination / Foreign は必ずこれ
    maxIntensity: intensityFromScale(earthquake?.['maxScale']),
    domesticTsunami: str(earthquake, 'domesticTsunami'),
    foreignTsunami: str(earthquake, 'foreignTsunami'),
    // Destination / Foreign では空配列。「震源はあるが震度はない」は正常な状態
    points: parsePoints(arr(data, 'points')),
    // 2024年のデータでは null、2024年8月以降は {"freeFormComment": ""}
    freeFormComment: str(obj(data, 'comments'), 'freeFormComment'),
    raw: data,
    historical,
  };
}

function parsePoints(points: unknown[]): QuakePoint[] {
  const out: QuakePoint[] = [];
  for (const p of points) {
    if (!isObject(p)) continue;
    const addr = str(p, 'addr');
    if (addr === null) continue;
    out.push({
      addr,
      pref: str(p, 'pref') ?? '',
      // 区域別（震度速報）と観測点別（各地の震度）で描画系統が違う
      isArea: bool(p, 'isArea'),
      intensity: intensityFromScale(p['scale']),
    });
  }
  return out;
}

function parseTsunami(
  data: Record<string, unknown>,
  receivedAt: number,
  historical: boolean,
): TsunamiEvent {
  const issue = obj(data, 'issue');
  const areas: TsunamiArea[] = [];
  for (const a of arr(data, 'areas')) {
    if (!isObject(a)) continue;
    const name = str(a, 'name');
    if (name === null) continue;
    const firstHeight = obj(a, 'firstHeight');
    areas.push({
      name,
      grade: str(a, 'grade') ?? 'Unknown',
      immediate: bool(a, 'immediate'),
      maxHeight: str(obj(a, 'maxHeight'), 'description'),
      // 到達予想時刻と状況は別物。1つの文字列に潰すと「いつ来るか」が出せない
      arrivalAt: parseJst(firstHeight?.['arrivalTime']),
      condition: str(firstHeight, 'condition'),
    });
  }

  return {
    kind: 'tsunami',
    id: recordId(data, 552),
    receivedFrom: 'p2p',
    receivedAt,
    issuedAt: parseJst(issue?.['time']),
    cancelled: bool(data, 'cancelled'),
    areas,
    raw: data,
    historical,
  };
}
