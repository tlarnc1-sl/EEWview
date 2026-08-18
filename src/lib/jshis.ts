/**
 * J-SHIS 表層地盤データ（防災科研）。
 *
 * 地点のAVS30を1点だけ引く。現在地を設定したときに一度呼び、結果は保存して使い回す。
 * ブラウザから直接叩ける（Access-Control-Allow-Origin: * を実測で確認済み）。
 *
 * 観測点4400点ぶんは事前に取って静的JSONにしてある（tools/build-avs30.py）。
 * ここで引くのは「利用者が指定した1点」だけ。
 */

const API = 'https://www.j-shis.bosai.go.jp/map/api/sstrct/V4/meshinfo.geojson';

export interface GroundInfo {
  /** 表層30m平均S波速度 (m/s) */
  avs30: number;
  /** 微地形区分名 */
  jname: string | null;
  /** 250mメッシュコード */
  mesh: string | null;
}

/**
 * 指定地点の表層地盤。取れなければ null。
 *
 * 水域（沿岸海域・湖沼・河道）では AVS=0 が返る。地盤データが無いという意味なので
 * 値ありとして扱わない。
 */
export async function fetchGround(
  lat: number,
  lon: number,
  fetchFn: typeof fetch = fetch,
): Promise<GroundInfo | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // position は「経度,緯度」の順。逆にすると日本の外を指す
  const url = `${API}?position=${lon.toFixed(5)},${lat.toFixed(5)}&epsg=4326`;

  try {
    const res = await fetchFn(url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: { properties?: Record<string, unknown> }[];
    };
    const props = data.features?.[0]?.properties;
    if (!props) return null;

    const avs30 = Number(props['AVS']);
    if (!Number.isFinite(avs30) || avs30 <= 0) return null;

    return {
      avs30,
      jname: typeof props['JNAME'] === 'string' ? props['JNAME'] : null,
      mesh: typeof props['meshcode'] === 'string' ? props['meshcode'] : null,
    };
  } catch {
    return null;
  }
}
