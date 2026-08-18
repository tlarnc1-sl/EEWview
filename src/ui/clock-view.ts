import { formatJstShort, formatJstTime } from '../util/jst';
import { h, setText } from './dom';

/**
 * 時計。詳細を出していないときの定位置の中身。
 *
 * 出すのは**補正済みの時刻**（Wolfxのサーバー時刻から推定したずれを足したもの）。
 * 端末の時計そのままではない。
 *
 * JSTであることを明記する。このアプリの時刻表示はすべてJST固定で、
 * 端末のタイムゾーンに従わない（APIがタイムゾーン無しの文字列を送ってくるため）。
 */
export class ClockPanel {
  readonly el: HTMLElement;
  private readonly time: HTMLElement;
  private readonly date: HTMLElement;

  constructor() {
    this.time = h('span', { class: 'clock__time' }, '--:--:--');
    this.date = h('span', { class: 'clock__date' }, '--/--');
    this.el = h(
      'div',
      { class: 'clock' },
      h(
        'div',
        { class: 'clock__main' },
        this.time,
        h('span', { class: 'clock__zone' }, 'JST'),
      ),
      this.date,
    );
  }

  render(now: number): void {
    setText(this.time, formatJstTime(now));
    // formatJstShort は "MM/DD HH:MM" なので、日付の部分だけ取る
    setText(this.date, formatJstShort(now).split(' ')[0] ?? '--/--');
  }
}
