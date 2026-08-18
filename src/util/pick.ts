/**
 * 生JSONからの安全な値取り出し。
 *
 * どちらのAPIも「仕様に無いフィールドが実在する」「仕様にあるフィールドが無い」
 * の両方が起きる。すべてオプショナル前提で読む。
 */

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function obj(src: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(src)) return null;
  const v = src[key];
  return isObject(v) ? v : null;
}

export function str(src: unknown, key: string): string | null {
  if (!isObject(src)) return null;
  const v = src[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return null;
}

/**
 * 数値を読む。NaN / Infinity は null にする。
 * 文字列で来た数値も受ける（Serial が文字列/数値で揺れるため）。
 */
export function num(src: unknown, key: string): number | null {
  if (!isObject(src)) return null;
  const v = src[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 欠損センチネル付きの数値を読む。
 * センチネルは**フィールドごとに独立**しているので、まとめて判定してはいけない。
 * 例: 遠地地震は震源があるのに depth だけ -1。
 */
export function numSentinel(
  src: unknown,
  key: string,
  sentinel: number,
): number | null {
  const n = num(src, key);
  if (n === null) return null;
  return n === sentinel ? null : n;
}

export function bool(src: unknown, key: string): boolean {
  if (!isObject(src)) return false;
  return src[key] === true;
}

export function arr(src: unknown, key: string): unknown[] {
  if (!isObject(src)) return [];
  const v = src[key];
  return Array.isArray(v) ? v : [];
}
