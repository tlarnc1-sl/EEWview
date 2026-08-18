import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  arrivalTimeFromRaw,
  predictArrival,
  remainDisplay,
  splitSeconds,
} from '../src/lib/arrival';
import {
  parseTravelTimeTable,
  travelTimes,
  waveRadii,
  type TravelTimeTable,
} from '../src/lib/travelTime';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { EewEvent } from '../src/types';

const table: TravelTimeTable = parseTravelTimeTable(
  readFileSync(new URL('../public/assets/tjma2001.txt', import.meta.url), 'utf8'),
);

/** 2026/08/17 14:00:00 JST 発震、茨城県沖、深さ60km */
const ORIGIN_MS = Date.parse('2026-08-17T05:00:00Z');

function eew(patch: Record<string, unknown> = {}): EewEvent {
  return parseWolfxMessage(
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
}

/** 震央から東へ指定距離の地点 */
function siteAt(km: number): { lat: number; lon: number } {
  const lat = 36.5;
  return { lat, lon: 141.0 + km / (111.195 * Math.cos((lat * Math.PI) / 180)) };
}

describe('走時表の逆引き（距離 → 走時）', () => {
  it('深さ60kmの実測値と合う', () => {
    // 震央直上
    expect(travelTimes(table, 60, 0).p).toBeCloseTo(8.9, 1);
    expect(travelTimes(table, 60, 0).s).toBeCloseTo(15.3, 1);
    // 100km
    expect(travelTimes(table, 60, 100).p).toBeCloseTo(16.9, 1);
    expect(travelTimes(table, 60, 100).s).toBeCloseTo(29.3, 1);
  });

  it('S波はP波より遅い', () => {
    for (const distance of [0, 30, 120, 500]) {
      const t = travelTimes(table, 30, distance);
      expect(t.s!, String(distance)).toBeGreaterThan(t.p!);
    }
  });

  it('遠いほど遅い', () => {
    let prev = 0;
    for (const distance of [0, 50, 100, 300, 800, 1500]) {
      const s = travelTimes(table, 30, distance).s!;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('表の外は外挿しない', () => {
    expect(travelTimes(table, 30, 2500)).toEqual({ p: null, s: null });
    expect(travelTimes(table, 800, 100)).toEqual({ p: null, s: null });
    expect(travelTimes(table, 30, Number.NaN)).toEqual({ p: null, s: null });
  });

  it('予報円と逆の関係になっている（円が届いた時刻＝到達予測）', () => {
    // 走時を引いて、その時刻の円の半径がその距離に戻る
    const distance = 150;
    const t = travelTimes(table, 60, distance).s!;
    expect(waveRadii(table, 60, t).s!).toBeCloseTo(distance, 0);
  });
});

describe('到達予測', () => {
  it('発震時刻に走時を足した時刻を返す', () => {
    const result = predictArrival(eew(), siteAt(100), table, ORIGIN_MS);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.arrival.distanceKm).toBeCloseTo(100, 0);
    expect(result.arrival.sTravelSec).toBeCloseTo(29.3, 1);
    expect(result.arrival.sAt).toBeCloseTo(ORIGIN_MS + 29_300, -2);
    // 発震ちょうどなら、残りは走時そのまま
    expect(result.arrival.sRemainSec).toBeCloseTo(29.3, 1);
    expect(result.arrival.pRemainSec).toBeCloseTo(16.9, 1);
  });

  it('時間が経つと残りが減る', () => {
    const at = (now: number) => {
      const r = predictArrival(eew(), siteAt(100), table, now);
      return r.kind === 'ok' ? r.arrival.sRemainSec : Number.NaN;
    };
    expect(at(ORIGIN_MS + 10_000)).toBeCloseTo(19.3, 1);
    expect(at(ORIGIN_MS + 29_300)).toBeCloseTo(0, 1);
    // 過ぎたら負
    expect(at(ORIGIN_MS + 40_000)).toBeLessThan(0);
  });

  it('震源要素は予報円と同じ粒度に丸めて使う', () => {
    // 深さ64km は 60km に丸められる
    const rounded = predictArrival(eew({ Depth: 64 }), siteAt(100), table, ORIGIN_MS);
    const exact = predictArrival(eew({ Depth: 60 }), siteAt(100), table, ORIGIN_MS);
    if (rounded.kind !== 'ok' || exact.kind !== 'ok') throw new Error('unavailable');
    expect(rounded.arrival.sTravelSec).toBe(exact.arrival.sTravelSec);
  });

  it('深発地震でも出す（予報円を描くのと揃える）', () => {
    const result = predictArrival(eew({ Depth: 200 }), siteAt(100), table, ORIGIN_MS);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // 深いぶん遅く着く
    expect(result.arrival.sTravelSec).toBeGreaterThan(40);
  });

  it('PLUM法では出さない（震源が無い）', () => {
    const plum = eew({ OriginalText: '37 03 00 ... RK94209 RT01/// 9999=' });
    const result = predictArrival(plum, siteAt(100), table, ORIGIN_MS);
    expect(result).toEqual({ kind: 'unavailable', reason: 'plum' });
  });

  it('現在地が未設定なら出さない', () => {
    expect(predictArrival(eew(), null, table, ORIGIN_MS)).toEqual({
      kind: 'unavailable',
      reason: 'no-site',
    });
  });

  it('震源・発震時刻が無ければ出さない', () => {
    expect(
      predictArrival(eew({ Latitude: null, Longitude: null }), siteAt(50), table, ORIGIN_MS),
    ).toEqual({ kind: 'unavailable', reason: 'no-hypocenter' });
    expect(
      predictArrival(eew({ OriginTime: null }), siteAt(50), table, ORIGIN_MS),
    ).toEqual({ kind: 'unavailable', reason: 'no-origin' });
  });

  it('震央距離が表の外なら出さない', () => {
    // 地球の反対側
    const result = predictArrival(eew(), { lat: -36.5, lon: -39 }, table, ORIGIN_MS);
    expect(result).toEqual({ kind: 'unavailable', reason: 'too-far' });
  });
});

describe('残り秒数の表示', () => {
  /** 画面に出る文字（UIは整数部と小数部を別々に組むので、ここでつなぐ） */
  const formatRemain = (remainSec: number): string => {
    const shown = remainDisplay(remainSec);
    if (shown.kind === 'text') return shown.text;
    const { whole, frac } = splitSeconds(shown.seconds);
    return `${whole}${frac}秒`;
  };

  it('0.1秒まで出す', () => {
    expect(formatRemain(20)).toBe('20.0秒');
    expect(formatRemain(3.42)).toBe('3.5秒');
    expect(formatRemain(0.24)).toBe('0.3秒');
  });

  it('切り上げる（まだ届いていないのに0.0秒とは出さない）', () => {
    expect(formatRemain(0.01)).toBe('0.1秒');
    expect(formatRemain(11.51)).toBe('11.6秒');
    // ちょうどの値はそのまま
    expect(formatRemain(2.5)).toBe('2.5秒');
  });

  it('到達したら0.0秒のまま止まる（数え上げない・文字に化けない）', () => {
    expect(formatRemain(0)).toBe('0.0秒');
    expect(formatRemain(-0.4)).toBe('0.0秒');
    expect(formatRemain(-120)).toBe('0.0秒');
    // 数字のままなので、桁も組み方も変わらない
    expect(remainDisplay(-12)).toEqual({ kind: 'count', seconds: 0 });
    expect(splitSeconds(0)).toEqual({ whole: '0', frac: '.0' });
  });

  it('NaN を出さない', () => {
    expect(formatRemain(Number.NaN)).toBe('—');
  });

  it('整数部と小数部を分けて出せる（大きさを変えて組むため）', () => {
    expect(remainDisplay(23.15)).toEqual({ kind: 'count', seconds: 23.2 });
    expect(splitSeconds(23.2)).toEqual({ whole: '23', frac: '.2' });
    expect(splitSeconds(0.1)).toEqual({ whole: '0', frac: '.1' });
    // 3桁でも数字は数字のまま。枠に収めるのは組み方の側の仕事
    expect(splitSeconds(120)).toEqual({ whole: '120', frac: '.0' });
  });

  it('値が取れないときだけ文字を返す', () => {
    expect(remainDisplay(Number.NaN)).toEqual({ kind: 'text', text: '—' });
    expect(remainDisplay(Number.POSITIVE_INFINITY)).toEqual({ kind: 'text', text: '—' });
  });

  it('浮動小数の丸め残りが出ない', () => {
    for (let ms = 1; ms < 3000; ms += 7) {
      const text = formatRemain(ms / 1000);
      expect(text, String(ms)).toMatch(/^\d+\.\d秒$/);
    }
  });

  it('文字での表示と分けた表示が食い違わない', () => {
    for (const sec of [-10, 0, 0.05, 1, 3, 3.1, 20, 99.5]) {
      const shown = remainDisplay(sec);
      const text = formatRemain(sec);
      if (shown.kind === 'text') expect(text, String(sec)).toBe(shown.text);
      else expect(text, String(sec)).toBe(`${shown.seconds.toFixed(1)}秒`);
      // 分けて組んでも同じ文字になる
      if (shown.kind === 'count') {
        const { whole, frac } = splitSeconds(shown.seconds);
        expect(`${whole}${frac}`).toBe(shown.seconds.toFixed(1));
      }
    }
  });
});

describe('気象庁が地域ごとに出す到達予測時刻', () => {
  const announced = Date.parse('2026-04-01T01:07:13Z'); // 10:07:13 JST

  it('hhmmss を報の日付で補って時刻にする', () => {
    // 実データ: 群馬県南部の Time = "100637"
    const at = arrivalTimeFromRaw('100637', announced)!;
    expect(new Date(at).toISOString()).toBe('2026-04-01T01:06:37.000Z');
  });

  it('日を跨ぐ場合は翌日として扱う', () => {
    const lateNight = Date.parse('2026-04-01T14:59:30Z'); // 23:59:30 JST
    const at = arrivalTimeFromRaw('000045', lateNight)!;
    // 翌日の 00:00:45 JST
    expect(new Date(at).toISOString()).toBe('2026-04-01T15:00:45.000Z');
  });

  it('埋め字や欠損では出さない', () => {
    expect(arrivalTimeFromRaw(null, announced)).toBeNull();
    expect(arrivalTimeFromRaw('//////', announced)).toBeNull();
    expect(arrivalTimeFromRaw('100637', null)).toBeNull();
  });
});
