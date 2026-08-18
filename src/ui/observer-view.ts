import type { EewEvent } from '../types';
import type { ObserverLocation } from '../observer';
import { describeUnavailable, predictForEew } from '../lib/eewPrediction';
import {
  describeArrivalUnavailable,
  predictArrival,
  remainDisplay,
  splitSeconds,
  IMMINENT_SEC,
  type ArrivalEstimate,
} from '../lib/arrival';
import type { TravelTimeTable } from '../lib/travelTime';
import { formatPredictionRange } from '../lib/intensityPrediction';
import { intensityNode } from './intensity-view';
import { intensityColor, intensityTextColor } from '../adapters/intensity';
import { fields, h, setClass, setText } from './dom';

/**
 * 設定した地点の推定震度。
 *
 * これは自前の計算であって気象庁の発表ではなく、誤差は±1階級が常態。
 * その断りは画面には出さない（毎回同じ文は壁紙になり、可変値の邪魔をする）。
 * 見る人がこれを作った本人であることが前提。経緯はREADMEに書いてある。
 *
 * 現在地が未設定なら何も出さない。
 */
export interface ObserverEstimateOptions {
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export class ObserverEstimate {
  readonly el: HTMLElement;
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  /** 補正済みの現在時刻。差し替えられるまでは最後に描いた時刻で止める */
  private clock: (() => number) | null = null;
  private lastNow = 0;
  /** カウントダウンだけを毎フレーム書き替えるための持ち物 */
  private countdown: CountdownParts | null = null;
  private pending: { eew: EewEvent; observer: ObserverLocation; table: TravelTimeTable } | null =
    null;
  private frame: number | null = null;

  constructor(options: ObserverEstimateOptions = {}) {
    this.el = h('div', { class: 'estimate' });
    this.el.hidden = true;
    this.requestFrame =
      options.requestFrame ?? ((cb) => requestAnimationFrame(() => cb()));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  }

  /**
   * 補正済みの時刻。0.1秒まで出すので、1秒ごとの再描画では足りない
   * （数字が1.0ずつ飛ぶ）。これを渡すと自分でフレームを回す。
   */
  setClock(now: () => number): void {
    this.clock = now;
  }

  private nowMs(): number {
    return this.clock === null ? this.lastNow : this.clock();
  }

  render(
    observer: ObserverLocation | null,
    eew: EewEvent | null,
    table: TravelTimeTable | null = null,
    now = Date.now(),
  ): void {
    this.lastNow = now;
    this.stop();
    this.countdown = null;
    this.pending = null;

    if (observer === null || eew === null) {
      this.el.hidden = true;
      this.el.replaceChildren();
      return;
    }
    this.el.hidden = false;

    const result = predictForEew(eew, {
      lat: observer.lat,
      lon: observer.lon,
      avs30: observer.avs30 ?? undefined,
    });

    const title = h(
      'p',
      { class: 'estimate__title' },
      observer.label ?? 'この地点',
    );

    // 主要動の到達予測。予報円と同じ表・同じ丸めで引く
    const countdown = this.arrivalRow(eew, observer, table, now);

    if (result.kind === 'unavailable') {
      // 出ない理由を書く。黙って空にすると「揺れない」と読めてしまう
      this.el.replaceChildren(
        title,
        ...(countdown ? [countdown] : []),
        h('p', { class: 'estimate__none' }, describeUnavailable(result.reason)),
      );
      return;
    }

    const { prediction } = result;
    const badge = h(
      'span',
      { class: 'estimate__value' },
      intensityNode(prediction.upper.intensity),
    );
    badge.style.background = intensityColor(prediction.upper.intensity);
    badge.style.color = intensityTextColor(prediction.upper.intensity);

    const notes: string[] = [`計測震度 ${prediction.upper.measured.toFixed(1)}`];
    // 上限と下限で階級が違うなら、気象庁と同じ「○○から○○」の幅で出す
    if (prediction.upper.intensity.value !== prediction.lower.intensity.value) {
      notes.push(`幅 ${formatPredictionRange(prediction)}`);
    }
    notes.push(`震央から${prediction.epicentralDistanceKm.toFixed(0)}km`);

    this.el.replaceChildren(
      title,
      ...(countdown ? [countdown] : []),
      h(
        'div',
        { class: 'estimate__row' },
        badge,
        fields('estimate__note', notes),
      ),
    );
  }

  /**
   * 主要動（S波）の到達カウントダウン。P波は補助として添える。
   *
   * 走時表を読めていないときは出さない（黙って0秒と書かない）。
   * 到達前なら、数字だけを毎フレーム書き替える枠として持っておく。
   */
  private arrivalRow(
    eew: EewEvent,
    observer: ObserverLocation,
    table: TravelTimeTable | null,
    now: number,
  ): HTMLElement | null {
    if (table === null) return null;

    const result = predictArrival(eew, { lat: observer.lat, lon: observer.lon }, table, now);
    if (result.kind === 'unavailable') {
      return h(
        'p',
        { class: 'estimate__arrival estimate__arrival--none' },
        describeArrivalUnavailable(result.reason),
      );
    }

    const parts = buildCountdown();
    this.countdown = parts;
    this.pending = { eew, observer, table };
    paintCountdown(parts, result.arrival);
    // 到達前だけフレームを回す。過ぎたあとは動かす値が無い
    if (result.arrival.sRemainSec > 0) this.start();
    return parts.row;
  }

  /**
   * 0.1秒まで出すには、1秒ごとの再描画では足りない（数字が1.0ずつ飛ぶ）。
   * カウントダウンの数字だけを毎フレーム書き替える。
   * 震源要素は報が来たときにしか変わらないので、ここでは引き直すだけ。
   */
  private start(): void {
    if (this.frame !== null || this.clock === null) return;
    const tick = (): void => {
      this.frame = null;
      if (!this.paint()) return;
      this.frame = this.requestFrame(tick);
    };
    this.frame = this.requestFrame(tick);
  }

  private stop(): void {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }

  /** 描き替えた／続ける必要があるか */
  private paint(): boolean {
    const parts = this.countdown;
    const pending = this.pending;
    if (parts === null || pending === null) return false;

    const result = predictArrival(
      pending.eew,
      { lat: pending.observer.lat, lon: pending.observer.lon },
      pending.table,
      this.nowMs(),
    );
    // 報の内容は変わっていないので、ここに来るのは「ok」だけ。
    // 念のため取れなければ止める（次の描画で理由が出る）
    if (result.kind !== 'ok') return false;

    paintCountdown(parts, result.arrival);
    // 到達したら止める。過ぎた時間を数え上げても読む値にならない
    return result.arrival.sRemainSec > 0;
  }
}

interface CountdownParts {
  row: HTMLElement;
  /** 数字の組（23.4秒）と、数字を出さないときの文字 */
  num: HTMLElement;
  whole: HTMLElement;
  frac: HTMLElement;
  unit: HTMLElement;
  text: HTMLElement;
}

/**
 * 残り秒数の枠。**整数部だけ大きく**、小数部と添え字は小さく置く。
 * 全部同じ大きさで組むと、桁数が増えたときに枠から出る。
 *
 * 「あと」は付けない。見出しが「主要動到達**まで**」と言っているので重複だし、
 * 数字を3桁ぶん右詰めで固定してあるため、1桁のときに「あと」との間が
 * 空いて見える（空きを枠の余白に見せるには、数字の左に何も置かないのがいい）。
 *
 * 何のカウントダウンかを見出しで言う。ここは**P波の残り秒数だった場所**で、
 * やめた理由は3つ:
 *   - 行動を決めるのは主要動。P波の残り秒数を読んで何かする場面が無い
 *   - 秒で動く数字が2つ並ぶと、大きいほうが何の数字か曖昧になる
 *   - P波が地表に出たことは地図の白い円で見える。数字で二重に持つ必要が無い
 * 見出しは状態で変わらない文字だが、**消える行が無くなるので高さが動かない**。
 * 到達の前後で枠の高さが変わるのは、統一感を壊すいちばんの原因になる。
 */
function buildCountdown(): CountdownParts {
  const whole = h('span', { class: 'estimate__countdown-sec' });
  const frac = h('span', { class: 'estimate__countdown-frac' });
  const unit = h('span', { class: 'estimate__countdown-unit' });
  const num = h('span', { class: 'estimate__countdown-num' }, whole, frac, unit);
  const text = h('span', { class: 'estimate__countdown-text' });
  const row = h(
    'div',
    { class: 'estimate__arrival' },
    h('span', { class: 'estimate__arrival-label' }, '主要動到達まで'),
    h('span', { class: 'estimate__countdown' }, num, text),
  );
  return { row, num, whole, frac, unit, text };
}

function paintCountdown(parts: CountdownParts, arrival: ArrivalEstimate): void {
  const shown = remainDisplay(arrival.sRemainSec);
  if (shown.kind === 'count') {
    const { whole, frac } = splitSeconds(shown.seconds);
    setText(parts.whole, whole);
    setText(parts.frac, frac);
    setText(parts.unit, '秒');
    // 使わない側は空にする。hidden にしただけでは文字が残り、
    // 読み上げや文字列としての取り出しに混ざる
    setText(parts.text, '');
    parts.num.hidden = false;
    parts.text.hidden = true;
  } else {
    setText(parts.text, shown.text);
    for (const el of [parts.whole, parts.frac, parts.unit]) setText(el, '');
    parts.num.hidden = true;
    parts.text.hidden = false;
  }

  /*
   * 差し迫っているあいだは強く出す（枠の大きさは変えない。地の色だけ）。
   * **到達しても赤は解かない。** 0.0秒で止まっている今がまさに揺れている時刻で、
   * ここで色が引くと「終わった」に読める。赤が引くのはEEW自体が消えるとき。
   */
  setClass(parts.row, 'estimate__arrival--imminent', arrival.sRemainSec <= IMMINENT_SEC);
  setClass(parts.row, 'estimate__arrival--passed', arrival.sRemainSec <= 0);
}

/**
 * 現在地の設定。
 *
 * 初回起動時に一度だけ出す。断られたら二度と出さない（設定からいつでも開ける）。
 * 位置は端末の外に出さない。J-SHISに座標を投げるのは地盤データを引くときだけで、
 * 結果は端末に保存して以後は使い回す。
 */
export interface ObserverSetupHandlers {
  useGeolocation: () => void;
  pickOnMap: () => void;
  dismiss: () => void;
}

export class ObserverSetup {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;

  constructor(handlers: ObserverSetupHandlers) {
    this.status = h('p', { class: 'setup__status' });

    const geo = h('button', { class: 'setup__btn', type: 'button' }, '現在地を使う');
    geo.addEventListener('click', () => handlers.useGeolocation());
    const pick = h('button', { class: 'setup__btn', type: 'button' }, '地図をクリックして指定');
    pick.addEventListener('click', () => handlers.pickOnMap());
    const later = h('button', { class: 'setup__btn setup__btn--quiet', type: 'button' }, 'あとで');
    later.addEventListener('click', () => handlers.dismiss());

    this.el = h(
      'div',
      { class: 'setup', role: 'dialog', 'aria-label': '現在地の設定' },
      h('h2', { class: 'setup__title' }, '現在地を設定しますか'),
      // 位置は端末に保存するだけで、外には出さない（J-SHISに座標を送るのは
      // 地盤データを引く1回だけ）。仕組みの説明は画面に出さない
      h('p', { class: 'setup__lead' }, 'EEW受信時に、その地点の推定震度を出します。'),
      h('div', { class: 'setup__buttons' }, geo, pick, later),
      this.status,
    );
    this.el.hidden = true;
  }

  setOpen(open: boolean): void {
    this.el.hidden = !open;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }
}
