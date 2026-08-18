import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseTravelTimeTable,
  surfaceArrivalDelay,
  waveRadii,
  type TravelTimeTable,
} from '../src/lib/travelTime';

/**
 * 実物の走時表（JMA2001）で固定する。
 * 近似式へのフォールバックは持たないので、ここが崩れると予報円は出せない。
 */
const table: TravelTimeTable = parseTravelTimeTable(
  readFileSync(new URL('../public/assets/tjma2001.txt', import.meta.url), 'utf8'),
);

describe('走時表のパース', () => {
  it('深さと震央距離の範囲が仕様どおり', () => {
    expect(table.depths[0]).toBe(0);
    expect(table.depths[table.depths.length - 1]).toBe(700);

    const rows = table.byDepth.get(0)!;
    expect(rows[0]!.distance).toBe(0);
    expect(rows[rows.length - 1]!.distance).toBe(2000);
  });

  it('震央距離の昇順に整列している', () => {
    for (const rows of table.byDepth.values()) {
      const distances = rows.map((r) => r.distance);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    }
  });

  it('走時は震央距離に対して単調増加（二分探索の前提）', () => {
    for (const rows of table.byDepth.values()) {
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.p).toBeGreaterThanOrEqual(rows[i - 1]!.p);
        expect(rows[i]!.s).toBeGreaterThanOrEqual(rows[i - 1]!.s);
      }
    }
  });

  it('固定長でも空白区切りでも同じに読める', () => {
    const t = parseTravelTimeTable('P    0.416 S    0.703   0      2\n');
    expect(t.byDepth.get(0)).toEqual([{ p: 0.416, s: 0.703, depth: 0, distance: 2 }]);
  });

  it('壊れた行は捨てる（例外にしない）', () => {
    const t = parseTravelTimeTable(
      ['', '   ', 'ゴミ', 'P 1.0 S', 'P    0.416 S    0.703   0      2'].join('\n'),
    );
    expect(t.depths).toEqual([0]);
    expect(t.byDepth.get(0)).toHaveLength(1);
  });
});

describe('半径の算出', () => {
  it('深さ60km・発生から57秒で、P波が400km台・S波が230km前後', () => {
    const r = waveRadii(table, 60, 57);
    expect(r.p).toBeGreaterThan(400);
    expect(r.p).toBeLessThan(500);
    expect(r.s).toBeGreaterThan(200);
    expect(r.s).toBeLessThan(260);
    // P波はS波より必ず先に進む
    expect(r.p!).toBeGreaterThan(r.s!);
  });

  it('まだ地表に届いていない時刻では null（0kmの円を描かない）', () => {
    // 深さ20kmの震央直上はP波3.38秒・S波5.757秒
    expect(waveRadii(table, 20, 3)).toEqual({ p: null, s: null });
    const justAfterP = waveRadii(table, 20, 4);
    expect(justAfterP.p).not.toBeNull();
    expect(justAfterP.s).toBeNull();
  });

  it('表の最大走時を超えたら null（範囲外）', () => {
    expect(waveRadii(table, 60, 100_000)).toEqual({ p: null, s: null });
  });

  it('深さが表の範囲外なら null', () => {
    expect(waveRadii(table, 800, 60)).toEqual({ p: null, s: null });
    expect(waveRadii(table, -1, 60)).toEqual({ p: null, s: null });
  });

  it('NaN を持ち込まない', () => {
    expect(waveRadii(table, Number.NaN, 60)).toEqual({ p: null, s: null });
    expect(waveRadii(table, 60, Number.NaN)).toEqual({ p: null, s: null });
  });

  it('表に無い深さは前後の深さから補間する', () => {
    // 55km は表にある深さ（50/55/60）の間隔次第。挟む2つの間に収まればよい
    const at50 = waveRadii(table, 50, 57).p!;
    const at60 = waveRadii(table, 60, 57).p!;
    const at55 = waveRadii(table, 55, 57).p!;
    const [lo, hi] = at50 < at60 ? [at50, at60] : [at60, at50];
    expect(at55).toBeGreaterThanOrEqual(lo);
    expect(at55).toBeLessThanOrEqual(hi);
  });

  it('時間が経つほど半径は単調に増える', () => {
    let prev = 0;
    for (let t = 10; t <= 200; t += 10) {
      const r = waveRadii(table, 30, t).s;
      if (r === null) continue;
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('返すのは震央距離。深さで補正し直さない', () => {
    // 震央直上に到達した直後の半径は0km近傍。震源距離（=深さ）にはならない
    const delay = surfaceArrivalDelay(table, 60);
    const r = waveRadii(table, 60, delay.p! + 0.001);
    expect(r.p!).toBeLessThan(1);
  });
});

describe('震央直上への到達時間', () => {
  it('深いほど円の出現が遅れる', () => {
    const shallow = surfaceArrivalDelay(table, 10);
    const deep = surfaceArrivalDelay(table, 150);
    expect(deep.p!).toBeGreaterThan(shallow.p!);
    expect(deep.s!).toBeGreaterThan(shallow.s!);
    // S波のほうが遅い
    expect(shallow.s!).toBeGreaterThan(shallow.p!);
  });

  it('範囲外の深さでは null', () => {
    expect(surfaceArrivalDelay(table, 900)).toEqual({ p: null, s: null });
  });

  it('到達時間を過ぎた直後から半径が出る', () => {
    const delay = surfaceArrivalDelay(table, 100);
    expect(waveRadii(table, 100, delay.s! - 0.01).s).toBeNull();
    expect(waveRadii(table, 100, delay.s! + 0.01).s).not.toBeNull();
  });
});
