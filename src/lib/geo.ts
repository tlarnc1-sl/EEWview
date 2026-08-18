/**
 * 球面上の幾何。予報円を測地線円として描くために使う。
 *
 * 走時表が返すのは地表に沿った距離（震央距離）なので、投影平面上の真円ではなく、
 * 震央から等距離にある地表の点を並べた多角形として描く。
 * 日本付近の緯度でも、半径が数百kmになると平面の円とはっきりずれる。
 */

/** 地球半径 (km)。球で近似する */
const EARTH_RADIUS_KM = 6371;

const DEG = Math.PI / 180;

/**
 * 中心から指定の地表距離だけ離れた点を、方位角を等分して並べる。
 * 返すのは [経度, 緯度] の配列。始点と終点は同じ点にせず、閉じるのは描画側の責任。
 */
export function geodesicCircle(
  lat: number,
  lon: number,
  radiusKm: number,
  segments = 128,
): [number, number][] {
  const points: [number, number][] = [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return points;
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return points;

  const phi1 = lat * DEG;
  const lambda1 = lon * DEG;
  // 中心角。半径が地球規模になっても破綻しない
  const delta = radiusKm / EARTH_RADIUS_KM;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  for (let i = 0; i < segments; i += 1) {
    const theta = (2 * Math.PI * i) / segments;
    const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta);
    const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * sinDelta * cosPhi1,
        cosDelta - sinPhi1 * sinPhi2,
      );
    points.push([normalizeLon(lambda2 / DEG), phi2 / DEG]);
  }
  return points;
}

/** 2点間の地表距離 (km)。テストと検算用 */
export function surfaceDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dPhi = (lat2 - lat1) * DEG;
  const dLambda = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function normalizeLon(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

export { EARTH_RADIUS_KM };
