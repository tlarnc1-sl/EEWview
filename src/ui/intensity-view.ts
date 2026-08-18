import type { Intensity } from '../types';
import {
  intensityColor,
  intensityLabel,
  intensityParts,
  intensityTextColor,
} from '../adapters/intensity';
import { h } from './dom';

/**
 * 震度の表示。
 *
 * 「5弱」と書くと、数字と漢字で見かけの大きさが揃わず読みにくい。
 * 数字（5）と符号（−／＋）に分け、符号は小さく・少し上に置く。
 * 数字も符号も斜体。フォントは Montserrat（同梱）で、本物のイタリック体
 * （傾き -11.3°）を持ち、数字にも斜体の字形がある。斜体を持たないフォントだと
 * ブラウザが機械的に傾けるだけになり、字形が崩れる。
 *
 * 気象庁の正式表記（5弱）は title 属性に残す。表記を変えても元が引けるように。
 */
export function intensityNode(
  intensity: Intensity | null,
  className = 'int',
): HTMLElement {
  const parts = intensityParts(intensity);
  const el = h('span', { class: className, title: intensityLabel(intensity) });
  el.append(h('span', { class: 'int__num' }, parts.num));
  if (parts.mod !== null) {
    el.append(h('span', { class: 'int__mod' }, parts.mod));
  }
  if (parts.note !== null) {
    // 46（5弱以上と推定されるが震度情報を入手していない）の不確かさを消さない
    el.append(h('span', { class: 'int__note' }, parts.note));
  }
  return el;
}

/**
 * 震度色を敷いた箱に入れる。色は気象庁の配色のまま。
 *
 * 色は CSS 変数（--int / --int-fg）にも入れる。グラデーションのように、
 * CSSでなければ書けない使い方をする箇所があるため。
 */
export function intensityBadge(
  intensity: Intensity | null,
  className: string,
): HTMLElement {
  const badge = h('span', { class: className }, intensityNode(intensity));
  const bg = intensityColor(intensity);
  const fg = intensityTextColor(intensity);
  badge.style.setProperty('--int', bg);
  badge.style.setProperty('--int-fg', fg);
  badge.style.background = bg;
  badge.style.color = fg;
  return badge;
}
