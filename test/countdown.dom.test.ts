// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ObserverEstimate } from '../src/ui/observer-view';
import { parseTravelTimeTable, type TravelTimeTable } from '../src/lib/travelTime';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { EewEvent } from '../src/types';

/**
 * 0.1秒まで出すので、1秒ごとの再描画では足りない（数字が1.0ずつ飛ぶ）。
 * カウントダウンだけが自分でフレームを回すことを確かめる。
 */

const table: TravelTimeTable = parseTravelTimeTable(
  readFileSync(`${process.cwd()}/public/assets/tjma2001.txt`, 'utf8'),
);

const ORIGIN_MS = Date.parse('2026-08-17T05:00:00Z');

const eew = (patch: Record<string, unknown> = {}): EewEvent =>
  parseWolfxMessage(
    {
      EventID: 'E1',
      Serial: 3,
      Title: '緊急地震速報（予報）',
      AnnouncedTime: '2026/08/17 14:00:08',
      OriginTime: '2026/08/17 14:00:00',
      Hypocenter: '茨城県沖',
      Latitude: 36.5,
      Longitude: 141.0,
      Magunitude: 6.5,
      Depth: 60,
      MaxIntensity: '5-',
      Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: '', Magnitude: '' },
      WarnArea: [],
      isCancel: false,
      OriginalText: '37 03 00 ... RK44559 RT01/// 9999=',
      ...patch,
    },
    { receivedAt: ORIGIN_MS, now: ORIGIN_MS },
  ) as EewEvent;

/** 震央から約100km（S波の到達は約29.3秒後） */
const OBSERVER = {
  lat: 36.5,
  lon: 141.0 + 100 / (111.195 * Math.cos((36.5 * Math.PI) / 180)),
  label: null,
  savedAt: ORIGIN_MS,
  avs30: 400,
  jname: '台地',
};

let now = ORIGIN_MS;
let frames: (() => void)[] = [];
let estimate: ObserverEstimate;

beforeEach(() => {
  now = ORIGIN_MS;
  frames = [];
  estimate = new ObserverEstimate({
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
  });
  estimate.setClock(() => now);
  document.body.replaceChildren(estimate.el);
});

/** 画面に出ている残り秒数 */
// 文字の間隔はCSSの gap で空けるので、textContent には空白が入らない
const shown = () => estimate.el.querySelector('.estimate__countdown')!.textContent;
const step = () => frames.pop()!();

describe('カウントダウンの刻み', () => {
  it('0.1秒まで出す', () => {
    estimate.render(OBSERVER, eew(), table, now);
    expect(shown()).toBe('29.3秒');
  });

  it('1秒未満でも進む（フレームごとに書き替える）', () => {
    estimate.render(OBSERVER, eew(), table, now);
    expect(frames).toHaveLength(1);

    now = ORIGIN_MS + 400;
    step();
    expect(shown()).toBe('28.9秒');

    now = ORIGIN_MS + 450;
    step();
    expect(shown()).toBe('28.9秒');

    now = ORIGIN_MS + 500;
    step();
    expect(shown()).toBe('28.8秒');
  });

  it('1秒経てばちょうど1.0秒減る', () => {
    estimate.render(OBSERVER, eew(), table, now);
    const before = shown();
    now = ORIGIN_MS + 1_000;
    step();
    expect(Number(/([\d.]+)秒/.exec(shown()!)![1])).toBeCloseTo(
      Number(/([\d.]+)秒/.exec(before!)![1]) - 1,
      6,
    );
  });

  it('到達したら0.0秒で止まる（過ぎた時間を数え上げない）', () => {
    estimate.render(OBSERVER, eew(), table, now);

    now = ORIGIN_MS + 40_000;
    step();
    // 0.0秒で止める。マイナスにも「到達（推定）」にもしない
    expect(shown()).toBe('0.0秒');
    // 次のフレームは積まない
    expect(frames).toHaveLength(0);
  });

  it('最初から到達済みならフレームを回さない', () => {
    estimate.render(OBSERVER, eew(), table, ORIGIN_MS + 40_000);
    expect(shown()).toBe('0.0秒');
    expect(frames).toHaveLength(0);
  });

  it('時計を渡されていなければ回さない（時刻が進まないので無駄）', () => {
    const still = new ObserverEstimate({
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => {},
    });
    still.render(OBSERVER, eew(), table, ORIGIN_MS);
    expect(still.el.querySelector('.estimate__countdown')!.textContent).toBe(
      '29.3秒',
    );
    expect(frames).toHaveLength(0);
  });

  it('描き直すと前のフレームは止める（二重に回さない）', () => {
    const cancelled: number[] = [];
    const e = new ObserverEstimate({
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: (h) => cancelled.push(h),
    });
    e.setClock(() => now);
    e.render(OBSERVER, eew(), table, now);
    e.render(OBSERVER, eew({ Serial: 4 }), table, now);
    expect(cancelled).toHaveLength(1);
  });

  it('差し迫ったら強く出す。数字は出し続ける', () => {
    estimate.render(OBSERVER, eew(), table, now);
    now = ORIGIN_MS + 27_500;
    step();

    const row = estimate.el.querySelector('.estimate__arrival')!;
    expect(row.classList.contains('estimate__arrival--imminent')).toBe(true);
    // 「まもなく」で数字を隠さない
    expect(shown()).toBe('1.8秒');
  });

  it('残り10秒で赤くなる（身構えるのに要る時間）', () => {
    const imminent = () =>
      estimate.el
        .querySelector('.estimate__arrival')!
        .classList.contains('estimate__arrival--imminent');

    // S波の到達は約29.3秒後。残り10.3秒ではまだ赤くしない
    estimate.render(OBSERVER, eew(), table, ORIGIN_MS + 19_000);
    expect(shown()).toBe('10.3秒');
    expect(imminent()).toBe(false);

    now = ORIGIN_MS + 19_400;
    step();
    expect(shown()).toBe('9.9秒');
    expect(imminent()).toBe(true);
  });

  it('到達しても赤は解かない（0.0秒で止まっている今が揺れている時刻）', () => {
    const imminent = () =>
      estimate.el
        .querySelector('.estimate__arrival')!
        .classList.contains('estimate__arrival--imminent');

    estimate.render(OBSERVER, eew(), table, ORIGIN_MS + 25_000);
    expect(imminent()).toBe(true);

    now = ORIGIN_MS + 40_000;
    step();
    expect(shown()).toBe('0.0秒');
    // ここで色が引くと「終わった」に読める
    expect(imminent()).toBe(true);
  });

  it('何のカウントダウンかを見出しで言う（P波の秒数は出さない）', () => {
    estimate.render(OBSERVER, eew(), table, now);
    expect(
      estimate.el.querySelector('.estimate__arrival-label')!.textContent,
    ).toBe('主要動到達まで');
    // P波の残り秒数は数字で持たない（地図の白い円で見える）
    expect(estimate.el.textContent).not.toContain('P波');
  });

  it('桁が変わっても枠の中身の数が変わらない（幅はCSSで固定する）', () => {
    // 3桁 → 2桁 → 1桁 と減っても、要素の構成は同じまま。
    // 幅の固定（min-width: 3ch と .estimate__arrival の width）はCSS側で、
    // 実ブラウザで測って確かめてある（README参照）
    const shape = () =>
      [...estimate.el.querySelectorAll('.estimate__countdown *')].map(
        (el) => el.className,
      );
    estimate.render(OBSERVER, eew(), table, ORIGIN_MS);
    const before = shape();
    expect(estimate.el.querySelector('.estimate__countdown-sec')!.textContent).toBe('29');

    now = ORIGIN_MS + 20_000;
    step();
    expect(estimate.el.querySelector('.estimate__countdown-sec')!.textContent).toBe('9');
    expect(shape()).toEqual(before);
  });

  it('到達しても枠の中身の数が変わらない（高さを動かさない）', () => {
    estimate.render(OBSERVER, eew(), table, now);
    const shape = () =>
      [...estimate.el.querySelector('.estimate__arrival')!.children].map(
        (el) => el.className,
      );
    const before = shape();

    now = ORIGIN_MS + 40_000;
    step();
    // 消える行も増える行も無い。変わるのは文字と色だけ
    expect(shape()).toEqual(before);
    expect(shown()).toBe('0.0秒');
  });
});
