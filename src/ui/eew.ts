import type { EewEvent, EewWarnArea, Intensity } from '../types';
import { intensityColor, intensityTextColor, maxIntensity } from '../adapters/intensity';
import { intensityBadge, intensityNode } from './intensity-view';
import { isPlumMethod } from '../lib/waveCircles';
import { arrivalTimeFromRaw } from '../lib/arrival';
import { formatJstTime } from '../util/jst';
import { fields, h } from './dom';

/** 発表中の津波（いちばん重い階級）。EEWのカードに載せる */
export interface TsunamiMark {
  code: string;
  label: string;
}

/** 津波の判定がまだ出ていない状態 */
export type PendingTsunami =
  | { kind: 'none' }
  | { kind: 'eew' }
  | { kind: 'checking'; sinceMs: number | null };

/**
 * 緊急情報の枠。**地図の左上に重ねる**。未解決のものがある間だけ出る。
 *
 * 一番大きく出すのは**最大予測震度**。報ごとに変わる値で、見る側の判断が
 * 一番動くのがここ。震源・規模・報番号はその下に小さく置く。
 *
 * 大地震の直後は余震で連続するので、進行中のものを縦に積む。
 * 地図に重ねているので、積んでも地図と一覧の位置は動かない。
 *
 * 並びは重み順:
 *   1. 最大予測震度（全国の最大。この地点の値は下中央のHUDにある）
 *   2. 気象庁のタイトル・震源・規模・報番号
 *   3. 対象地域（震度別・全件）
 *   4. 津波の判定待ち
 *   5. 2件目以降のEEW（余震など、控えめ）
 *
 * **この地点の推定と到達予測はここに置かない**（地図の下中央のHUD）。
 * 同じ形の震度バッジを近くに2つ並べると、どちらがどこの震度か分からなくなる。
 * 場所で分け、それぞれに名前を付ける。
 *
 * 地図に重ねるので、**高さが伸び続けないようにする**（地域が多いときは枠内で
 * スクロールする。CSS側の max-height）。
 *
 * 津波の判定待ちは**確定した数字のあと**。「まだ分からない」という保留の情報で、
 * 確定値より前に出す理由が無い。ただし余震のEEWより前に置いて、
 * 連続しても画面外に押し出されないようにする。理由は3つ:
 *   - EEWが出ない規模でも 551 は調査中を出す。EEW専用の列だと行き場が無くなる
 *   - 判定待ちはEEWの表示より長生きする。列ごと消すと
 *     「津波なし」と「まだ分からない」の区別が付かなくなる
 *   - 連続EEWのとき、どの地震の判定かをこちらは知らない。
 *     特定のカードの中に入れると、根拠のない結びつけになる
 * なので列の持ち物にはせず、カードの外に固定する。
 */
export class EewPanel {
  readonly el: HTMLElement;
  private lastSignature = '';

  constructor() {
    // 出す・引っ込めるは CSS 側（.app--eew）。hidden は使わない
    this.el = h('div', { class: 'eew-overlay' });
  }

  render(
    eews: EewEvent[],
    pending: PendingTsunami = { kind: 'none' },
    tsunami: TsunamiMark | null = null,
  ): void {
    const signature = [
      ...eews.map((e) => `${e.eventId}:${e.serial}:${e.isCancel}`),
      pendingSignature(pending),
      tsunami?.code ?? '',
    ].join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const children: HTMLElement[] = [];
    const notice = pendingNotice(pending);

    eews.forEach((e, i) => {
      children.push(card(e, i === 0, tsunami));
      // 判定待ちは主カードの直後。余震のEEWより前
      if (i === 0 && notice) children.push(notice);
    });
    // EEWが無く判定待ちだけのとき（551が調査中）
    if (eews.length === 0 && notice) children.push(notice);

    this.el.replaceChildren(...children);
  }
}

/**
 * 地域ごとの到達予測。気象庁の値（WarnArea の Time）をそのまま出す。
 * PLUM法などで予測が無い地域は、その旨（Arrive の文言）を短くして添える。
 *
 * 時刻は地名と別の要素にする。文字列に足すと、時刻が地名の一部に見える。
 */
function areaArrival(
  area: EewWarnArea,
  announcedAt: number | null,
): { at: number | null; text: string | null } {
  const at = arrivalTimeFromRaw(area.arriveTimeRaw, announcedAt);
  if (at !== null) return { at, text: formatJstTime(at) };
  if (area.arrive === null) return { at: null, text: null };
  if (area.arrive.includes('既に到達')) return { at: null, text: '到達済み' };
  if (area.arrive.includes('予測なし')) return { at: null, text: '予測なし' };
  return { at: null, text: null };
}

function pendingSignature(pending: PendingTsunami): string {
  if (pending.kind !== 'checking') return pending.kind;
  // 経過時間は分単位でしか出さないので、分が変わったときだけ描き直す
  return `checking:${Math.floor((pending.sinceMs ?? 0) / 60_000)}`;
}

/**
 * 津波の判定がまだ出ていないこと。
 * 「発表はありません」とは書かない。無いと断定してはいけない。
 */
function pendingNotice(pending: PendingTsunami): HTMLElement | null {
  if (pending.kind === 'none') return null;
  if (pending.kind === 'eew') return h('div', { class: 'pending' }, '津波 調査中');

  // 気象庁が「調査中」と言っている。時間が経っていることも隠さない
  const minutes = pending.sinceMs === null ? null : Math.floor(pending.sinceMs / 60_000);
  const suffix = minutes !== null && minutes >= 1 ? `（${minutes}分経過）` : '';
  return h('div', { class: 'pending' }, `津波 調査中${suffix}`);
}

function card(
  eew: EewEvent,
  primary: boolean,
  tsunami: TsunamiMark | null,
): HTMLElement {
  const classes = ['eew'];
  if (!primary) classes.push('eew--secondary');
  if (eew.isWarn && !eew.isCancel) classes.push('eew--warn');
  if (eew.isCancel) classes.push('eew--cancel');

  return h(
    'article',
    { class: classes.join(' ') },
    // 警報は予報より緊迫して見えるようにする（赤白のストライプはCSS側）
    eew.isWarn && !eew.isCancel ? h('div', { class: 'eew__hazard' }) : null,
    // 津波が発表されている間は、どのEEWにも載せる
    tsunami !== null
      ? h(
          'div',
          { class: `eew__tsunami eew__tsunami--${tsunami.code}` },
          h('span', { class: 'eew__tsunami-text' }, '津波情報 発表中'),
          h('span', { class: 'eew__tsunami-grade' }, tsunami.label),
        )
      : null,
    head(eew),
    // 気象庁が付けたタイトルをそのまま出す
    h('h2', { class: 'eew__title' }, eew.title ?? '気象庁の発表を受信'),
    // 取消では震源名を大きく出さない。通常の報と見分けが付かなくなる
    eew.isCancel
      ? null
      : h('p', { class: 'eew__hypo' }, eew.hypocenter.name ?? '震源調査中'),
    fields('eew__scale', scaleFields(eew)),
    fields('eew__report', reportFields(eew)),
    flagRow(eew),
    ...(eew.isCancel ? [] : areaList(eew.warnAreas, eew.announcedAt)),
  );
}

/**
 * 見出し。全体の最大予測震度。
 *
 * 「最大予測」と名前を付ける。この地点の推定（HUD）と同じ形のバッジなので、
 * どちらがどこの震度かを名前で分ける。
 */
function head(eew: EewEvent): HTMLElement {
  return h(
    'div',
    { class: 'eew__head' },
    h(
      'div',
      { class: 'eew__max' },
      // 取消に「最大予測」と付けると、値があるように読める
      eew.isCancel ? null : h('span', { class: 'eew__label' }, '最大予測'),
      intensityBlock(eew),
    ),
  );
}

function intensityBlock(eew: EewEvent): HTMLElement {
  if (eew.isCancel) {
    // 取消では震度を出さない。値が残っていると誤読の元になる
    return h('div', { class: 'eew__intensity eew__intensity--cancel' }, '取消');
  }
  const box = h(
    'div',
    { class: 'eew__intensity' },
    intensityNode(eew.maxIntensity, 'eew__intensity-value'),
  );
  box.style.background = intensityColor(eew.maxIntensity);
  box.style.color = intensityTextColor(eew.maxIntensity);
  return box;
}

function scaleFields(eew: EewEvent): string[] {
  const depth =
    eew.hypocenter.depthKm === null
      ? '深さ不明'
      : eew.hypocenter.depthKm === 0
        ? 'ごく浅い'
        : `深さ${eew.hypocenter.depthKm}km`;
  return [
    // 取消では震源名を大きく出さないので、こちらに小さく残す
    eew.isCancel ? eew.hypocenter.name : null,
    eew.hypocenter.magnitude !== null
      ? `M${eew.hypocenter.magnitude.toFixed(1)}`
      : 'M不明',
    depth,
  ].filter((v): v is string => v !== null && v !== '');
}

function reportFields(eew: EewEvent): string[] {
  return [`第${eew.serial}報`, formatJstTime(eew.announcedAt)];
}

/**
 * 状態の印。**報番号や時刻より目立たせる**。
 *
 * 「最終報」は「この数字で確定・これ以上更新されない」という状態の変化点で、
 * 薄い字で並べる情報ではない。震源の信用度も同じ。
 * 付くものが無ければ行ごと出さない（空の枠は状態を語らない）。
 */
function flagRow(eew: EewEvent): HTMLElement | null {
  const flags: string[] = [];
  // この地震についての続報は出ない、という気象庁の指示
  if (eew.isFinal) flags.push('最終報');
  // 震源が仮定・低精度の報は、位置を信用してはいけない。
  // PLUM法と分かっているなら、それを名指ししたほうが情報が多い
  if (isPlumMethod(eew)) flags.push('PLUM法');
  else if (!eew.epicenterReliable) flags.push('震源低精度');
  if (flags.length === 0) return null;

  return h(
    'div',
    { class: 'eew__flags' },
    ...flags.map((f) => h('span', { class: 'eew__flag' }, f)),
  );
}

/**
 * 対象地域を震度別にまとめて全件出す。
 *
 * 地域名と震度は気象庁の発表内容そのもの。見出しはこのアプリの言葉になるので、
 * 「警報」「注意報」等は使わず「強い揺れ」と書く。
 *
 * 震度別のまとまりの中は**到達の早い順**に並べ替える。気象庁の並び順は
 * 地域コード順で、探すときの役に立たない。時刻が無い地域は後ろ。
 */
function areaList(areas: EewWarnArea[], announcedAt: number | null): HTMLElement[] {
  if (areas.length === 0) return [];

  interface Entry {
    name: string;
    at: number | null;
    text: string | null;
  }
  const groups = new Map<number, { intensity: Intensity | null; entries: Entry[] }>();
  for (const area of areas) {
    // 上限・下限のうち強いほうで分ける。低いほうで見せて揺れを小さく見せない
    const intensity = maxIntensity(area.upper, area.lower);
    const key = intensity?.value ?? -1;
    const group = groups.get(key) ?? { intensity, entries: [] };
    // 気象庁が出している到達予測時刻を添える。自前計算より確か
    group.entries.push({ name: area.name, ...areaArrival(area, announcedAt) });
    groups.set(key, group);
  }

  const rows = [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, group]) => {
      const badge = intensityBadge(group.intensity, 'eew__area-grade');
      const entries = [...group.entries].sort(
        (a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY),
      );
      return h(
        'li',
        { class: 'eew__area' },
        badge,
        h(
          'span',
          { class: 'eew__area-names' },
          ...entries.map((e) =>
            h(
              'span',
              { class: 'eew__area-name' },
              e.name,
              e.text === null ? null : h('span', { class: 'eew__area-at' }, e.text),
            ),
          ),
        ),
      );
    });

  return [
    h('p', { class: 'eew__area-title' }, `強い揺れ ${areas.length}地域`),
    h('ul', { class: 'eew__areas' }, ...rows),
  ];
}
