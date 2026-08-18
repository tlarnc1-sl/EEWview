import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hasUsableAvs,
  maxByArea,
  predictStations,
  type StationsFile,
} from '../src/lib/stationPrediction';
import { amplificationFromAvs30 } from '../src/lib/intensityPrediction';

/**
 * 生成した観測点＋AVS30データそのものを検査する。
 * 取り違えや欠測を、使う側ではなくデータの時点で捕まえる。
 */
const file = JSON.parse(
  readFileSync(`${process.cwd()}/public/assets/stations-avs30.json`, 'utf8'),
) as StationsFile;

const stations = file.stations;

describe('観測点データ', () => {
  it('気象庁の震度観測点がそろっている', () => {
    // 実際の観測点数は約4400点
    expect(stations.length).toBeGreaterThan(4000);
    expect(new Set(stations.map((s) => s.name)).size).toBe(stations.length);
  });

  it('座標が日本の範囲に収まっている', () => {
    for (const s of stations) {
      expect(s.lat, s.name).toBeGreaterThan(20);
      expect(s.lat, s.name).toBeLessThan(46);
      expect(s.lon, s.name).toBeGreaterThan(122);
      expect(s.lon, s.name).toBeLessThan(154);
    }
  });

  it('地域が入っている（地域ごとの最大を出すのに要る）', () => {
    const areas = new Set(stations.map((s) => s.area).filter(Boolean));
    // 気象庁の地震情報の区域は約190
    expect(areas.size).toBeGreaterThan(180);
    expect(stations.filter((s) => s.area === null)).toHaveLength(0);
  });

  it('出典を残してある', () => {
    expect(file.source['avs30']).toContain('J-SHIS');
    expect(file.source['stations']).toContain('気象庁');
  });
});

describe('AVS30', () => {
  const usable = stations.filter(hasUsableAvs);

  it('ほとんどの観測点で引けている', () => {
    expect(usable.length / stations.length).toBeGreaterThan(0.97);
  });

  it('物理的にありえない値が入っていない', () => {
    for (const s of usable) {
      // 松岡・翠川の適用範囲は 100 < AVS < 1500
      expect(s.avs30!, s.name).toBeGreaterThan(50);
      expect(s.avs30!, s.name).toBeLessThan(1500);
    }
  });

  it('水域（AVS=0）を使える値として扱わない', () => {
    const water = stations.filter((s) => s.avs30 === 0);
    for (const s of water) {
      expect(hasUsableAvs(s)).toBe(false);
    }
  });

  it('分布が日本の地盤として妥当', () => {
    const values = usable.map((s) => s.avs30!).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)]!;
    // 沖積平野から台地まで含めた中央値はおおむね300前後
    expect(median).toBeGreaterThan(250);
    expect(median).toBeLessThan(450);
  });

  it('微地形区分が入っていて、地盤の硬さと矛盾しない', () => {
    const byJname = new Map<string, number[]>();
    for (const s of usable) {
      if (!s.jname) continue;
      const list = byJname.get(s.jname) ?? [];
      list.push(s.avs30!);
      byJname.set(s.jname, list);
    }
    const mean = (name: string): number => {
      const v = byJname.get(name);
      if (!v || v.length < 5) return Number.NaN;
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    // 台地は低地より硬い。逆転していたら座標か換算がおかしい
    const terrace = mean('砂礫質台地');
    const lowland = mean('後背湿地');
    expect(Number.isFinite(terrace) && Number.isFinite(lowland)).toBe(true);
    expect(terrace).toBeGreaterThan(lowland);
  });

  it('増幅率が発散しない', () => {
    for (const s of usable) {
      const amp = amplificationFromAvs30(s.avs30!);
      expect(Number.isFinite(amp), s.name).toBe(true);
      expect(amp, s.name).toBeLessThan(4);
    }
  });
});

describe('このデータで震度を予測する', () => {
  it('観測点ごとに計算し、地域ごとの最大を代表にできる', () => {
    // 茨城県沖 M7.0 深さ20km
    const result = predictStations(
      { lat: 36.5, lon: 141.0, depthKm: 20, magnitude: 7.0 },
      stations,
    );
    expect(result.stations.length).toBeGreaterThan(4000);

    const areas = maxByArea(result.stations);
    expect(areas.size).toBeGreaterThan(180);

    // 震源に近い茨城の地域が、遠い九州の地域より強い
    const ibaraki = [...areas.entries()].find(([name]) => name.includes('茨城'))![1];
    const kyushu = [...areas.entries()].find(([name]) => name.includes('鹿児島'))![1];
    expect(ibaraki.prediction.upper.measured).toBeGreaterThan(
      kyushu.prediction.upper.measured,
    );
    expect(ibaraki.intensity.value).toBeGreaterThanOrEqual(45);
  });

  it('深さ150km超では1点も予測しない', () => {
    const result = predictStations(
      { lat: 36.5, lon: 141.0, depthKm: 200, magnitude: 7.0 },
      stations,
    );
    expect(result.stations).toEqual([]);
  });
});
