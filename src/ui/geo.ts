import japan from './japan.json';
import stations from './stations.json';

/**
 * 地図の投影と座標引き。
 *
 * 地図ライブラリは使わない。タイルも読まない。
 * GeoJSONを間引いた japan.json（都道府県ポリゴン）から直接SVGを組む。
 * オフラインで起動できることが条件。
 */

/** 日本列島の表示範囲。ここから外れた震源は「範囲外」として扱う */
export const VIEW = {
  lonMin: 122.0,
  lonMax: 149.5,
  latMin: 24.0,
  latMax: 46.0,
} as const;

/** 描画キャンバスの論理サイズ（SVGのviewBox） */
export const CANVAS = { width: 1000, height: 1000 } as const;

/**
 * 正距円筒図法を緯度で縦横比補正しただけの投影。
 * 日本の緯度帯（24〜46度）ならこれで形は破綻しない。
 */
const LAT_CENTER = (VIEW.latMin + VIEW.latMax) / 2;
const LON_SCALE = Math.cos((LAT_CENTER * Math.PI) / 180);

const spanX = (VIEW.lonMax - VIEW.lonMin) * LON_SCALE;
const spanY = VIEW.latMax - VIEW.latMin;
const SCALE = Math.min(CANVAS.width / spanX, CANVAS.height / spanY);
const OFFSET_X = (CANVAS.width - spanX * SCALE) / 2;
const OFFSET_Y = (CANVAS.height - spanY * SCALE) / 2;

export interface Point {
  x: number;
  y: number;
}

export function project(lon: number, lat: number): Point {
  return {
    x: OFFSET_X + (lon - VIEW.lonMin) * LON_SCALE * SCALE,
    y: OFFSET_Y + (VIEW.latMax - lat) * SCALE,
  };
}

/** 投影の逆。地図をクリックした位置から緯度経度を出すのに使う */
export function unproject(x: number, y: number): { lat: number; lon: number } {
  return {
    lon: VIEW.lonMin + (x - OFFSET_X) / (LON_SCALE * SCALE),
    lat: VIEW.latMax - (y - OFFSET_Y) / SCALE,
  };
}

/**
 * 表示中の矩形（投影後の座標系）。SVGの viewBox にそのまま渡す。
 * 全域が {0, 0, 1000, 1000}。拡大するとこれが小さくなる。
 */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_VIEWPORT: Viewport = {
  x: 0,
  y: 0,
  w: CANVAS.width,
  h: CANVAS.height,
};

/** 拡大しすぎないための下限。1000 のうち 130 ＝ 日本列島の約1/8 */
const MIN_SPAN = 130;

/**
 * 与えた点がすべて入る矩形を作る。
 *
 * 揺れた場所が画面に収まる程度まで寄せるためのもので、
 * 1点しか無いときに極端に拡大しないよう下限を設けている。
 * 正方形に揃えるのは、SVG側が preserveAspectRatio="meet" で
 * 縦横比を吸収するため（横長の画面でも中身がずれない）。
 */
export function fitViewport(points: Point[], padding = 0.12): Viewport {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length === 0) return FULL_VIEWPORT;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of usable) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY) * (1 + padding * 2);
  const size = Math.min(Math.max(span, MIN_SPAN), CANVAS.width);

  // 端の地震で余白ばかりにならないよう、地図の中に押し戻す
  const x = clamp(cx - size / 2, 0, CANVAS.width - size);
  const y = clamp(cy - size / 2, 0, CANVAS.height - size);
  return { x, y, w: size, h: size };
}

/** ある地点を中心に、指定した幅で切り出す（EEWの震源を見せるときに使う） */
export function centerViewport(center: Point, size: number): Viewport {
  const s = Math.min(Math.max(size, MIN_SPAN), CANVAS.width);
  return {
    x: clamp(center.x - s / 2, 0, CANVAS.width - s),
    y: clamp(center.y - s / 2, 0, CANVAS.height - s),
    w: s,
    h: s,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 表示範囲の内側か。遠地地震の震源は範囲外に出る */
export function inView(lon: number, lat: number): boolean {
  return (
    lon >= VIEW.lonMin && lon <= VIEW.lonMax && lat >= VIEW.latMin && lat <= VIEW.latMax
  );
}

/**
 * 範囲外の点を、地図の縁に貼り付けた位置に丸める。
 * 「そっちの方角にある」ことだけを示す。位置として読んではいけないので、
 * 呼び出し側は inView() を見て表示を変えること。
 */
export function clampToView(lon: number, lat: number): Point {
  const clampedLon = Math.min(Math.max(lon, VIEW.lonMin), VIEW.lonMax);
  const clampedLat = Math.min(Math.max(lat, VIEW.latMin), VIEW.latMax);
  return project(clampedLon, clampedLat);
}

interface Pref {
  code: number;
  name: string;
  rings: number[][];
}

const PREFS = (japan as { prefs: Pref[] }).prefs;

/** 都道府県ポリゴンのSVGパス。起動時に1回だけ作れば以後変わらない */
export function prefecturePaths(): { code: number; name: string; d: string }[] {
  return PREFS.map((pref) => ({
    code: pref.code,
    name: pref.name,
    d: pref.rings.map(ringToPath).join(' '),
  }));
}

function ringToPath(flat: number[]): string {
  let d = '';
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = project(flat[i] as number, flat[i + 1] as number);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return `${d}Z`;
}

interface StationTable {
  /** 観測点名 → [lon, lat] */
  s: Record<string, [number, number] | undefined>;
}

const STATIONS = stations as unknown as StationTable;

/**
 * 観測点名から座標を引く。P2Pのpointsは名前しか持たないので、
 * 気象庁の観測点一覧（JMAstations.json）から引く。
 *
 * 区域（isArea=true の震度速報）は引かない。区域は面であって点ではなく、
 * 代表点を自前で作ると、気象庁が発表していない位置を発表内容として描くことになる。
 * 区域ポリゴンを入れるまでは地図に打たず、一覧に出す。
 *
 * 引けない名前は null（地図に描かないだけで、一覧には残る）。
 */
export function lookupStation(addr: string): [number, number] | null {
  return STATIONS.s[addr] ?? null;
}

export const stationCount = Object.keys(STATIONS.s).length;
