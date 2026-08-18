import type { Intensity } from '../types';

/**
 * 気象庁震度階級。
 *
 * 46 は「震度5弱以上と推定されるが震度情報を入手していない」。
 * 数値としては45と50の間だが、表示は「5弱以上」。
 * 通常運用ではまず出ないが、大地震でこそ出る（観測点が被災して値を送れない）。
 */
const SCALE_LABELS: ReadonlyMap<number, string> = new Map([
  [10, '1'],
  [20, '2'],
  [30, '3'],
  [40, '4'],
  [45, '5弱'],
  [46, '5弱以上'],
  [50, '5強'],
  [55, '6弱'],
  [60, '6強'],
  [70, '7'],
]);

/**
 * 気象庁の震度配色。
 * 白背景を前提にした色なので、暗色の画面では暗い縁を付けて背景から切り離す
 * （styles.css の .row__intensity / .chip__intensity）。色そのものは変えない。
 */
const SCALE_COLORS: ReadonlyMap<number, string> = new Map([
  [10, '#F2F2FF'],
  [20, '#00AAFF'],
  [30, '#0041FF'],
  [40, '#FAE696'],
  [45, '#FFE01F'],
  [46, '#FFE01F'],
  [50, '#FFA300'],
  [55, '#FF2800'],
  [60, '#A50021'],
  [70, '#B40068'],
]);

/** 震度色の上に載せる文字色（背景の明度に合わせる） */
const SCALE_FG: ReadonlyMap<number, string> = new Map([
  [10, '#1a1a1a'],
  [20, '#1a1a1a'],
  [30, '#ffffff'],
  [40, '#1a1a1a'],
  [45, '#1a1a1a'],
  [46, '#1a1a1a'],
  [50, '#1a1a1a'],
  [55, '#ffffff'],
  [60, '#ffffff'],
  [70, '#ffffff'],
]);

/**
 * P2Pの scale 値を Intensity に変換する。
 * -1（情報なし）と未知の値は null を返す。呼び出し側で「情報なし」として扱う。
 */
export function intensityFromScale(scale: unknown): Intensity | null {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return null;
  const label = SCALE_LABELS.get(scale);
  if (label === undefined) return null;
  return { value: scale, label };
}

/**
 * Wolfxの MaxIntensity（文字列 "3" / "5-" / "5+" …）を Intensity に変換する。
 * 数値ではないので比較・ソートには value を使うこと。
 */
export function intensityFromJmaString(s: unknown): Intensity | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  switch (t) {
    case '1':
      return { value: 10, label: '1' };
    case '2':
      return { value: 20, label: '2' };
    case '3':
      return { value: 30, label: '3' };
    case '4':
      return { value: 40, label: '4' };
    case '5-':
    case '5弱':
      return { value: 45, label: '5弱' };
    case '5+':
    case '5強':
      return { value: 50, label: '5強' };
    case '6-':
    case '6弱':
      return { value: 55, label: '6弱' };
    case '6+':
    case '6強':
      return { value: 60, label: '6強' };
    case '7':
      return { value: 70, label: '7' };
    default:
      return null;
  }
}

/** 震度階級を持たない（情報なし）ときの色。暗色画面に合わせた無彩色 */
const UNKNOWN_BG = '#3a414b';
const UNKNOWN_FG = '#c8cdd4';

/**
 * 表示用に、数字・符号・注記へ分解する。
 *
 * 「5弱」のように漢字を混ぜると、数字と漢字で見かけの大きさが揃わず読みにくい。
 * 数字（5）と符号（−／＋）に分け、符号は小さく少し上に、斜体で置く。
 * 46（5弱以上と推定されるが震度情報を入手していない）は注記で不確かさを残す。
 */
export interface IntensityParts {
  num: string;
  /** 弱 → "−"、強 → "+"。付かない震度は null */
  mod: '+' | '−' | null;
  /** 「以上」など。無ければ null */
  note: string | null;
}

const PARTS: ReadonlyMap<number, IntensityParts> = new Map([
  [0, { num: '0', mod: null, note: null }],
  [10, { num: '1', mod: null, note: null }],
  [20, { num: '2', mod: null, note: null }],
  [30, { num: '3', mod: null, note: null }],
  [40, { num: '4', mod: null, note: null }],
  [45, { num: '5', mod: '−', note: null }],
  [46, { num: '5', mod: '−', note: '以上' }],
  [50, { num: '5', mod: '+', note: null }],
  [55, { num: '6', mod: '−', note: null }],
  [60, { num: '6', mod: '+', note: null }],
  [70, { num: '7', mod: null, note: null }],
]);

const UNKNOWN_PARTS: IntensityParts = { num: '—', mod: null, note: null };

export function intensityParts(intensity: Intensity | null): IntensityParts {
  if (!intensity) return UNKNOWN_PARTS;
  return PARTS.get(intensity.value) ?? UNKNOWN_PARTS;
}

/** 分解した表記を1つの文字列にする（title 属性や読み上げ用） */
export function intensityText(intensity: Intensity | null): string {
  const p = intensityParts(intensity);
  return `${p.num}${p.mod ?? ''}${p.note ?? ''}`;
}

export function intensityColor(intensity: Intensity | null): string {
  if (!intensity) return UNKNOWN_BG;
  return SCALE_COLORS.get(intensity.value) ?? UNKNOWN_BG;
}

export function intensityTextColor(intensity: Intensity | null): string {
  if (!intensity) return UNKNOWN_FG;
  return SCALE_FG.get(intensity.value) ?? UNKNOWN_FG;
}

export function intensityLabel(intensity: Intensity | null): string {
  return intensity ? intensity.label : '—';
}

/**
 * 計測震度（実数）から震度階級を出す。
 *
 *   I < 0.5 → 0 / 0.5-1.5 → 1 / … / 4.5-5.0 → 5弱 / 5.0-5.5 → 5強 /
 *   5.5-6.0 → 6弱 / 6.0-6.5 → 6強 / 6.5 ≤ → 7
 *
 * 震度0を返しうるので、観測値のコード（10〜70）とは別の入口にしてある。
 */
const MEASURED_THRESHOLDS: readonly [number, number][] = [
  [6.5, 70],
  [6.0, 60],
  [5.5, 55],
  [5.0, 50],
  [4.5, 45],
  [3.5, 40],
  [2.5, 30],
  [1.5, 20],
  [0.5, 10],
];

export function intensityFromMeasured(measured: number): Intensity {
  if (!Number.isFinite(measured)) return { value: 0, label: '0' };
  for (const [threshold, value] of MEASURED_THRESHOLDS) {
    if (measured >= threshold) {
      return { value, label: SCALE_LABELS.get(value) as string };
    }
  }
  return { value: 0, label: '0' };
}

/** 大きいほうを返す。null は「情報なし」として常に負ける */
export function maxIntensity(
  a: Intensity | null,
  b: Intensity | null,
): Intensity | null {
  if (!a) return b;
  if (!b) return a;
  return b.value > a.value ? b : a;
}
