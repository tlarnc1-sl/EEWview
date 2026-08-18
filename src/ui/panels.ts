import type { TsunamiArea, TsunamiEvent } from '../types';
import type { MergedQuake } from '../store/quake';
import { intensityBadge } from './intensity-view';
import { formatJstShort, formatJstTime } from '../util/jst';
import { h, setText } from './dom';

/**
 * 津波の欄。
 *
 * 出るのは、対象区域のある発表（552）を受けたときだけ。
 * そのときは地震情報と同じ高さの独立した列になる（App 側が app--tsunami を立てる）。
 *
 * 一番大きく出すのは**高さ**と**いつ来るか**。区域名も階級名もその手がかりで、
 * 判断を決めるのはこの2つ。
 *
 * 階級名は気象庁の呼称（大津波警報／津波警報／津波注意報）をそのまま使う。
 * 背景も気象庁の配色に合わせて塗る。薄めない。
 */

/** 気象庁の階級。コード → 呼称・重さ・呼びかけ */
interface TsunamiGrade {
  label: string;
  rank: number;
  /**
   * その階級で気象庁が呼びかけている行動。
   * このアプリが考えた文言ではなく、気象庁の呼びかけに合わせる。
   */
  action: string | null;
}

const GRADES: Record<string, TsunamiGrade> = {
  MajorWarning: { label: '大津波警報', rank: 3, action: 'いますぐ高台へ避難' },
  Warning: { label: '津波警報', rank: 2, action: 'いますぐ高台へ避難' },
  Watch: { label: '津波注意報', rank: 1, action: 'いますぐ海から上がる' },
  Unknown: { label: '不明', rank: 0, action: null },
};

export function tsunamiGradeLabel(grade: string): string {
  return GRADES[grade]?.label ?? grade;
}

/**
 * 発表中の津波のうち、いちばん重い階級。
 * EEWのカードに「津波情報 発表中」を載せるのに使う。
 */
export function heaviestTsunamiGrade(
  tsunami: TsunamiEvent | null,
): { code: string; label: string } | null {
  if (!hasActiveTsunami(tsunami) || tsunami === null) return null;
  let best: TsunamiArea | null = null;
  for (const area of tsunami.areas) {
    if (best === null || gradeRank(area.grade) > gradeRank(best.grade)) best = area;
  }
  if (best === null) return null;
  return { code: best.grade, label: tsunamiGradeLabel(best.grade) };
}

function gradeRank(grade: string): number {
  return GRADES[grade]?.rank ?? 0;
}

/**
 * 「いつ来るか」。
 * 到達中・直ちに来襲は時刻より強い情報なので、時刻より優先して出す。
 */
export function arrivalText(area: TsunamiArea): string {
  if (area.immediate) return '直ちに来襲';
  if (area.condition !== null) return area.condition;
  if (area.arrivalAt !== null) return formatJstTime(area.arrivalAt);
  return '不明';
}

export class TsunamiPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;

  constructor() {
    this.body = h('div', { class: 'panel__body tsunami' });
    this.el = h(
      'section',
      { class: 'panel panel--tsunami' },
      h('h2', { class: 'panel__title' }, '津波'),
      this.body,
    );
  }

  render(tsunami: TsunamiEvent | null, awaitingJudgement: boolean): void {
    if (awaitingJudgement) {
      this.body.replaceChildren(
        h('p', { class: 'tsunami__waiting' }, '津波の判定を待っています'),
      );
      return;
    }
    if (!tsunami) {
      this.body.replaceChildren(
        h('p', { class: 'tsunami__none' }, '受信した発表はありません'),
      );
      return;
    }
    if (tsunami.cancelled || tsunami.areas.length === 0) {
      this.body.replaceChildren(
        h('p', { class: 'tsunami__none' }, '解除（対象区域なし）'),
        h('p', { class: 'tsunami__time' }, formatJstShort(tsunami.issuedAt)),
      );
      return;
    }

    // 階級の重い順。数が多いときに上から読めばいい
    const areas = [...tsunami.areas].sort(
      (a, b) => gradeRank(b.grade) - gradeRank(a.grade),
    );

    this.body.replaceChildren(
      ...actionBlock(tsunami, areas),
      h('ul', { class: 'tsunami__list' }, ...areas.map(areaRow)),
      h('p', { class: 'tsunami__time' }, `${formatJstShort(tsunami.issuedAt)} 発表`),
    );
  }
}

/**
 * 何をすべきか。列の最上部に、いちばん重い階級のものを1つ出す。
 *
 * 文言は気象庁の呼びかけに合わせる。こちらで考えた指示は出さない。
 *
 * **過去の発表では出さない。** サンドボックスの再生や、接続直後に投げ込まれた
 * 古い報で避難を促すのは、この道具が嘘をつくのと同じ。
 * どの区域が対象かとこちらの現在地の対応は持っていないので、
 * 「あなたの地域は」とは言わない（全体としての呼びかけに留める）。
 */
function actionBlock(
  tsunami: TsunamiEvent,
  areas: readonly TsunamiArea[],
): HTMLElement[] {
  if (tsunami.historical) return [];

  const heaviest = areas[0];
  if (heaviest === undefined) return [];
  const grade = GRADES[heaviest.grade];
  if (!grade || grade.action === null) return [];

  return [
    h(
      'div',
      { class: `tsunami__action tsunami__action--${heaviest.grade}` },
      h('span', { class: 'tsunami__action-text' }, grade.action),
      h('span', { class: 'tsunami__action-grade' }, grade.label),
    ),
  ];
}

function areaRow(area: TsunamiArea): HTMLElement {
  return h(
    'li',
    { class: `tsunami__area tsunami__area--${area.grade}` },
    h(
      'div',
      { class: 'tsunami__head' },
      h('span', { class: 'tsunami__name' }, area.name),
      h('span', { class: 'tsunami__grade' }, tsunamiGradeLabel(area.grade)),
    ),
    // 判断を決めるのはこの2つ。だから一番大きい
    h(
      'div',
      { class: 'tsunami__main' },
      h('span', { class: 'tsunami__height' }, area.maxHeight ?? '高さ不明'),
      h('span', { class: 'tsunami__arrival' }, arrivalText(area)),
    ),
  );
}

/**
 * 発表種別の表示名。
 *
 * P2Pのコードをそのまま出しても意味が伝わらないので日本語にする。
 * 「速報」「警報」「注意報」およびまぎらわしい語は、このアプリ自身の出力として
 * 使わない決まりなので、震度速報は「震度の第一報」と書く。
 */
const ISSUE_TYPE_LABELS: Record<string, string> = {
  // 震源はまだ無く、区域別の震度だけが出た第一報（震度3以上で発表される）
  ScalePrompt: '震度の第一報（区域別）',
  // 震源と規模だけ。震度の情報は無い
  Destination: '震源に関する情報',
  // 観測点別の震度が付いた報
  DetailScale: '各地の震度',
  Foreign: '遠地地震',
  Other: 'その他',
};

export function issueTypeLabel(type: string): string {
  return ISSUE_TYPE_LABELS[type] ?? type;
}

/**
 * 地震情報が「津波を調査中」と言っているか。
 * 気象庁のコードをそのまま見る（言い換えると意味がずれる）。
 */
export function isTsunamiChecking(quake: MergedQuake | null | undefined): boolean {
  return quake?.domesticTsunami === 'Checking';
}

/**
 * 対象区域のある津波の発表を受けているか。
 * これが true の間だけ、津波の欄を独立した列に出す。
 */
export function hasActiveTsunami(tsunami: TsunamiEvent | null): boolean {
  return tsunami !== null && !tsunami.cancelled && tsunami.areas.length > 0;
}

/** 最近の地震一覧。平常時の主役 */
export class QuakeList {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private onSelect: ((key: string) => void) | null = null;
  private selectedKey: string | null = null;

  constructor() {
    // 見出しは持たない。一番上が最新だと分かるよう、先頭の行を大きくする
    this.body = h('div', { class: 'panel__body' });
    this.el = h('section', { class: 'panel panel--list' }, this.body);
  }

  select(fn: (key: string) => void): void {
    this.onSelect = fn;
  }

  setSelected(key: string | null): void {
    this.selectedKey = key;
  }

  render(quakes: MergedQuake[]): void {
    if (quakes.length === 0) {
      this.body.replaceChildren(
        h('p', { class: 'list__empty' }, '受信した地震情報はまだありません'),
      );
      return;
    }

    const rows = quakes.slice(0, 30).map((q, index) => {
      const badge = intensityBadge(q.maxIntensity, 'row__intensity');

      const classes = ['row'];
      // 一番上が最新。見出しを置く代わりに、その行を大きくする
      if (index === 0) classes.push('row--first');
      if (q.key === this.selectedKey) classes.push('row--selected');

      const row = h(
        'button',
        { class: classes.join(' '), type: 'button' },
        badge,
        h(
          'span',
          { class: 'row__body' },
          h(
            'span',
            { class: 'row__head' },
            h('span', { class: 'row__place' }, q.hypocenter.name ?? '震源調査中'),
            // 津波はメタ行に置くと深さと時刻の間に割り込んで幅を食う。
            // 震源名の行の右端に、出ているときだけ短い印として付ける
            tsunamiMark(q),
          ),
          // 縦線で区切る。列幅を固定して、上下の行で線の位置が揃うようにする
          h(
            'span',
            { class: 'row__meta' },
            h('span', { class: 'row__field' }, magnitudeText(q)),
            h('span', { class: 'row__field' }, depthText(q)),
          ),
        ),
        /*
         * 地震情報の発震時刻は分単位（P2Pの earthquake.time は秒が常に00で、
         * 気象庁の発表自体が分単位）。秒を出すと持っていない精度に見える。
         * 秒を持つのはEEWの OriginTime だけ。
         */
        h('span', { class: 'row__time' }, formatJstShort(q.occurredAt)),
      );
      row.addEventListener('click', () => this.onSelect?.(q.key));
      return row;
    });
    this.body.replaceChildren(...rows);
  }
}

function magnitudeText(q: MergedQuake): string {
  return q.hypocenter.magnitude !== null
    ? `M${q.hypocenter.magnitude.toFixed(1)}`
    : 'M不明';
}

function depthText(q: MergedQuake): string {
  if (q.hypocenter.depthKm === null) return '深さ不明';
  if (q.hypocenter.depthKm === 0) return 'ごく浅い';
  return `深さ${q.hypocenter.depthKm}km`;
}

/**
 * 一覧に付ける津波の印。**日本語で出す**（`Warning` では何のことか分からない）。
 * 階級名は気象庁のもの（大津波警報／津波警報／津波注意報）。
 *
 * 「なし」は出さない——並びに何も足さないほうが、出ている行が目に入る。
 * 「不明」も出さない（受信していないだけで、無いとは言えない。
 * 調査中は別の言葉なので、そちらは出す）。
 */
const TSUNAMI_MARKS: Record<string, { text: string; kind: string }> = {
  MajorWarning: { text: '大津波警報', kind: 'major' },
  Warning: { text: '津波警報', kind: 'warning' },
  Watch: { text: '津波注意報', kind: 'watch' },
  Checking: { text: '津波 調査中', kind: 'quiet' },
  NonEffective: { text: '海面変動', kind: 'quiet' },
};

function tsunamiMark(q: MergedQuake): HTMLElement | null {
  const mark = q.domesticTsunami === null ? undefined : TSUNAMI_MARKS[q.domesticTsunami];
  if (!mark) return null;
  return h('span', { class: `row__tsunami row__tsunami--${mark.kind}` }, mark.text);
}

/**
 * 選択中の地震の詳細（震度の強い観測点から並べる）。
 *
 * **既定では出さない。** 震度の分布は地図に出ているので、観測点名の一覧は
 * 常に必要なものではない。出すかどうかは設定で決める（折りたたみは持たない）。
 */
export class QuakeDetail {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor() {
    this.title = h('h2', { class: 'panel__title' }, '詳細');
    this.body = h('div', { class: 'panel__body' });
    this.el = h('section', { class: 'panel panel--detail' }, this.title, this.body);
  }

  render(quake: MergedQuake | null): void {
    const label = this.title;
    if (!quake) {
      setText(label, '詳細');
      this.body.replaceChildren(h('p', { class: 'list__empty' }, '—'));
      return;
    }

    // 一覧のどれを出しているかは発震時刻で分かる（一覧の行も同じ時刻を出す）
    setText(label, `詳細 ${formatJstShort(quake.occurredAt)}`);

    const header = h(
      'p',
      { class: 'detail__head' },
      quake.hypocenter.name ?? '震源調査中',
    );
    // どの種類の報をどの順で受けて、この1件になったか
    const history = h(
      'p',
      {
        class: 'detail__reports',
        // 元の種別コードも残しておく（照合に要る）
        title: quake.issueTypes.join(' → '),
      },
      `${quake.issueTypes.map(issueTypeLabel).join(' → ')}（${quake.reportIds.length}報）`,
    );

    if (quake.points.length === 0) {
      // Destination と Foreign は「震源はあるが震度はない」
      this.body.replaceChildren(
        header,
        history,
        h('p', { class: 'list__empty' }, '震度の情報はありません'),
      );
      return;
    }

    const items = quake.points.slice(0, 60).map((p) => {
      const badge = intensityBadge(p.intensity, 'chip__intensity');
      return h('li', { class: 'chip' }, badge, h('span', { class: 'chip__name' }, p.addr));
    });

    const more =
      quake.points.length > 60
        ? h('p', { class: 'detail__more' }, `ほか ${quake.points.length - 60} 地点`)
        : null;

    this.body.replaceChildren(
      header,
      history,
      // 観測点の数は一覧ではなくここに書く
      h(
        'p',
        { class: 'detail__kind' },
        quake.pointsAreArea
          ? `区域別 ${quake.points.length}区域`
          : `観測点別 ${quake.points.length}点`,
      ),
      h('ul', { class: 'chips' }, ...items),
      ...(more ? [more] : []),
    );
  }
}
