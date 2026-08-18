import type {
  Hypocenter,
  Intensity,
  QuakeInfoEvent,
  QuakeIssueType,
  QuakePoint,
} from '../types';
import { EMPTY_HYPOCENTER } from '../types';

/**
 * 同一地震にまとまった状態。
 *
 * 同じ地震について、種別の違う報が順不同で並ぶ。
 *   [ScalePrompt, Destination, DetailScale]  震度3以上ならこの形
 *   [Foreign, DetailScale]                   遠地地震
 *   [DetailScale]                            小さい地震はいきなり確定報
 * 「速報→確定」の固定順を仮定してはいけない。
 *
 * 種別ごとに持ち込む情報が違う（Destination は震源、DetailScale は震度）ので、
 * 単純な置換ではなく要素ごとにマージする。
 */
export interface MergedQuake {
  /** earthquake.time の生文字列。P2Pの地震情報にはEventIDが無い */
  key: string;
  occurredAt: number | null;
  hypocenter: Hypocenter;
  maxIntensity: Intensity | null;
  /** 最も詳しい震度分布。観測点別があればそれを、無ければ区域別を持つ */
  points: QuakePoint[];
  /** points が区域別（震度速報）か。描画系統が違う */
  pointsAreArea: boolean;
  domesticTsunami: string | null;
  foreignTsunami: string | null;
  freeFormComment: string | null;
  /** これまでに受けた発表種別 */
  issueTypes: QuakeIssueType[];
  /** 取り込んだ報のID */
  reportIds: string[];
  /** 最新報の発表時刻 */
  latestIssuedAt: number | null;
  /** 最後にこの地震の情報が更新された時刻（クライアント時刻） */
  updatedAt: number;
  historical: boolean;
}

export function createMerged(event: QuakeInfoEvent): MergedQuake {
  return applyReport(
    {
      key: event.quakeKey,
      occurredAt: event.occurredAt,
      hypocenter: { ...EMPTY_HYPOCENTER },
      maxIntensity: null,
      points: [],
      pointsAreArea: false,
      domesticTsunami: null,
      foreignTsunami: null,
      freeFormComment: null,
      issueTypes: [],
      reportIds: [],
      latestIssuedAt: null,
      updatedAt: event.receivedAt,
      historical: event.historical,
    },
    event,
  );
}

/**
 * 1報をマージする。
 *
 * 順序逆転（古い報が後から届く）は普通に起きるので、
 * 新しい情報を持ち込むのは「発表時刻が現在保持中以降の報」だけにする。
 * ただし、まだ誰も埋めていない欄は古い報からでも埋める。
 */
export function applyReport(
  base: MergedQuake,
  event: QuakeInfoEvent,
): MergedQuake {
  const merged: MergedQuake = {
    ...base,
    hypocenter: { ...base.hypocenter },
    issueTypes: base.issueTypes.includes(event.issueType)
      ? base.issueTypes
      : [...base.issueTypes, event.issueType],
    reportIds: base.reportIds.includes(event.id)
      ? base.reportIds
      : [...base.reportIds, event.id],
    updatedAt: Math.max(base.updatedAt, event.receivedAt),
    historical: base.historical && event.historical,
  };

  const isNewer =
    base.latestIssuedAt === null ||
    event.issuedAt === null ||
    event.issuedAt >= base.latestIssuedAt;

  // 震源要素は独立に更新する。
  // 後の報でM7.4→M7.6と訂正されることがある一方、
  // 震源を持たない報（震度速報）で既知の震源を消してはいけない。
  merged.hypocenter = mergeHypocenter(base.hypocenter, event.hypocenter, isNewer);

  if (event.maxIntensity !== null && (isNewer || base.maxIntensity === null)) {
    merged.maxIntensity = event.maxIntensity;
  }
  if (event.occurredAt !== null && (isNewer || base.occurredAt === null)) {
    merged.occurredAt = event.occurredAt;
  }
  if (event.domesticTsunami !== null && (isNewer || base.domesticTsunami === null)) {
    merged.domesticTsunami = event.domesticTsunami;
  }
  if (event.foreignTsunami !== null && (isNewer || base.foreignTsunami === null)) {
    merged.foreignTsunami = event.foreignTsunami;
  }
  if (event.freeFormComment !== null && isNewer) {
    merged.freeFormComment = event.freeFormComment;
  }

  // 観測点別（各地の震度）は区域別（震度速報）より詳しい。
  // 区域別の報が後から届いても、既にある観測点別を捨てない。
  if (event.points.length > 0) {
    const incomingIsArea = event.points.some((p) => p.isArea);
    const upgrade = base.points.length === 0 || (base.pointsAreArea && !incomingIsArea);
    const sameKind = base.pointsAreArea === incomingIsArea;
    if (upgrade || (sameKind && isNewer)) {
      merged.points = sortPoints(event.points);
      merged.pointsAreArea = incomingIsArea;
    }
  }

  if (event.issuedAt !== null && isNewer) {
    merged.latestIssuedAt = event.issuedAt;
  }

  return merged;
}

function mergeHypocenter(
  base: Hypocenter,
  incoming: Hypocenter,
  isNewer: boolean,
): Hypocenter {
  const take = <T>(current: T | null, next: T | null): T | null => {
    if (next === null) return current;
    if (current === null) return next;
    return isNewer ? next : current;
  };
  // 緯度経度は組で扱う。片方だけ新しい報から取ると混ざった座標になる
  const hasIncomingLatLon = incoming.lat !== null && incoming.lon !== null;
  const hasBaseLatLon = base.lat !== null && base.lon !== null;
  const useIncomingLatLon = hasIncomingLatLon && (isNewer || !hasBaseLatLon);

  return {
    name: take(base.name, incoming.name),
    lat: useIncomingLatLon ? incoming.lat : base.lat,
    lon: useIncomingLatLon ? incoming.lon : base.lon,
    depthKm: take(base.depthKm, incoming.depthKm),
    magnitude: take(base.magnitude, incoming.magnitude),
  };
}

/** 震度の強い順。同値なら元の順を保つ */
function sortPoints(points: QuakePoint[]): QuakePoint[] {
  return [...points].sort(
    (a, b) => (b.intensity?.value ?? -1) - (a.intensity?.value ?? -1),
  );
}
