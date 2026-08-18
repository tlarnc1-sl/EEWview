/** 素のDOM操作のための最小ヘルパー。フレームワークは使わない。 */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/**
 * 項目を横に並べる。区切りに文字（「/」など）を使わず、間隔で分ける。
 * 空の項目は落とす。
 */
export function fields(
  className: string,
  items: (string | null | undefined)[],
): HTMLElement {
  const el = h('div', { class: className });
  for (const item of items) {
    if (item === null || item === undefined || item === '') continue;
    el.append(h('span', {}, item));
  }
  return el;
}

/** 中身が変わったときだけ書き換える（アイドル時に触らない） */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}
