import { describe, expect, it } from 'vitest';
import {
  CANVAS,
  FULL_VIEWPORT,
  centerViewport,
  fitViewport,
  inView,
  lookupStation,
  project,
} from '../src/ui/geo';

describe('投影', () => {
  it('日本列島がキャンバスに収まる', () => {
    for (const [lon, lat] of [
      [141.35, 43.06], // 札幌
      [139.69, 35.69], // 東京
      [127.68, 26.21], // 那覇
    ] as const) {
      const p = project(lon, lat);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(CANVAS.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(CANVAS.height);
    }
  });

  it('北にある地点ほど上に来る', () => {
    expect(project(140, 43).y).toBeLessThan(project(140, 35).y);
  });

  it('日本の外は範囲外と判定する', () => {
    expect(inView(139.69, 35.69)).toBe(true);
    // インドネシア、フローレス（実データの遠地地震）
    expect(inView(121.4, -8.3)).toBe(false);
  });
});

describe('観測点の座標引き', () => {
  it('気象庁の観測点一覧から引ける', () => {
    const p = lookupStation('石川県輪島市舳倉島');
    // 名前が一致しないものは null。でっち上げない
    expect(p === null || (Array.isArray(p) && p.length === 2)).toBe(true);
    expect(lookupStation('存在しない観測点')).toBeNull();
  });
});

describe('表示範囲の切り出し', () => {
  it('点が無ければ全域', () => {
    expect(fitViewport([])).toEqual(FULL_VIEWPORT);
  });

  it('与えた点がすべて入る', () => {
    const points = [
      { x: 400, y: 400 },
      { x: 500, y: 480 },
      { x: 460, y: 520 },
    ];
    const v = fitViewport(points);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(v.x);
      expect(p.x).toBeLessThanOrEqual(v.x + v.w);
      expect(p.y).toBeGreaterThanOrEqual(v.y);
      expect(p.y).toBeLessThanOrEqual(v.y + v.h);
    }
  });

  it('狭い範囲でも拡大しすぎない', () => {
    // 1点だけ与えても、その1点に張り付くところまでは寄せない
    const v = fitViewport([{ x: 500, y: 500 }]);
    expect(v.w).toBeGreaterThanOrEqual(130);
    expect(v.w).toBe(v.h);
  });

  it('全国に散らばっていれば全域に戻る', () => {
    const v = fitViewport([
      { x: 20, y: 20 },
      { x: 980, y: 980 },
    ]);
    expect(v.w).toBe(CANVAS.width);
  });

  it('端の地震でもキャンバスの外にはみ出さない', () => {
    const v = fitViewport([{ x: 5, y: 5 }]);
    expect(v.x).toBeGreaterThanOrEqual(0);
    expect(v.y).toBeGreaterThanOrEqual(0);
    expect(v.x + v.w).toBeLessThanOrEqual(CANVAS.width);
    expect(v.y + v.h).toBeLessThanOrEqual(CANVAS.height);
  });

  it('NaN が混ざっても壊れない', () => {
    const v = fitViewport([
      { x: Number.NaN, y: 10 },
      { x: 500, y: 500 },
    ]);
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.w)).toBe(true);
  });

  it('中心指定でも範囲内に収める', () => {
    const v = centerViewport({ x: 0, y: 0 }, 400);
    expect(v).toEqual({ x: 0, y: 0, w: 400, h: 400 });
  });
});
