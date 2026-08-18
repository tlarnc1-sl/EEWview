/**
 * JST時刻文字列のパース。
 *
 * WolfxもP2Pもタイムゾーン情報を持たない文字列を送ってくる。
 * ブラウザのローカルタイムで解釈すると、JST以外の環境で9時間ずれる。
 * 必ずJST（UTC+9）固定で解釈する。
 *
 * 書式の揺れ:
 *   Wolfx  "2026/04/02 01:00:15"        秒まで
 *   P2P    "2024/01/01 16:24:58.633"    ミリ秒3桁
 *   P2P    "2026/08/16 18:08:54.4"      末尾のゼロが落ちる（1桁）
 * ミリ秒を固定桁と仮定してはいけない。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const PATTERN =
  /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;

/**
 * JSTの日時文字列を epoch ms に変換する。
 * 解釈できなければ null。NaN を返さない（NaN は表示層まで滑り込むので）。
 */
export function parseJst(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const m = PATTERN.exec(input.trim());
  if (!m) return null;

  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  // "4" は 400ms、"63" は 630ms。右詰めではなく左詰めで解釈する
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, '0').slice(0, 3));

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms) - JST_OFFSET_MS;
  return Number.isFinite(t) ? t : null;
}

/**
 * epoch ms を、APIが送ってくるのと同じ書式の文字列にする。
 * 動作確認用の電文を本物と同じ形で組み立てるために使う。
 */
export function formatJstStamp(t: number, withMillis = false): string {
  const d = new Date(t + JST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base =
    `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return withMillis ? `${base}.${p(d.getUTCMilliseconds(), 3)}` : base;
}

/** epoch ms を JST の "HH:MM:SS" にする */
export function formatJstTime(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return '--:--:--';
  const d = new Date(t + JST_OFFSET_MS);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** epoch ms を JST の "MM/DD HH:MM" にする */
export function formatJstShort(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return '--/-- --:--';
  const d = new Date(t + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** epoch ms を JST の "MM/DD HH:MM:SS" にする。発震時刻は秒まで要る */
export function formatJstDateTime(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return '--/-- --:--:--';
  const d = new Date(t + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export { JST_OFFSET_MS };
