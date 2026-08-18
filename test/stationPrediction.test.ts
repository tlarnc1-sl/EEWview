import { describe, expect, it } from 'vitest';
import {
  maxByArea,
  maxStation,
  predictStations,
  type AvsStation,
} from '../src/lib/stationPrediction';

/** 観測点ごとに計算し、地域ごとの最大を代表にする（気象庁と同じ集約） */

const station = (patch: Partial<AvsStation>): AvsStation => ({
  name: 'テスト観測点',
  code: '0000000',
  lat: 35.0,
  lon: 139.0,
  pref: '東京都',
  area: '東京都２３区',
  avs30: 400,
  jname: '台地',
  mesh: '5339',
  ...patch,
});

const SOURCE = { lat: 35.0, lon: 139.0, depthKm: 20, magnitude: 7.0 };

describe('観測点ごとの予測', () => {
  it('震源に近い点ほど強く出る', () => {
    const near = station({ name: '近い', lat: 35.1, lon: 139.0 });
    const far = station({ name: '遠い', lat: 36.5, lon: 139.0 });
    const { stations } = predictStations(SOURCE, [near, far]);

    const byName = new Map(stations.map((s) => [s.station.name, s]));
    expect(byName.get('近い')!.prediction.upper.measured).toBeGreaterThan(
      byName.get('遠い')!.prediction.upper.measured,
    );
  });

  it('同じ距離でも地盤が柔らかいほど強く出る', () => {
    const soft = station({ name: '軟らかい', lat: 35.3, avs30: 200 });
    const hard = station({ name: '硬い', lat: 35.3, avs30: 800 });
    const { stations } = predictStations(SOURCE, [soft, hard]);

    const byName = new Map(stations.map((s) => [s.station.name, s]));
    expect(byName.get('軟らかい')!.prediction.upper.measured).toBeGreaterThan(
      byName.get('硬い')!.prediction.upper.measured,
    );
  });

  it('AVS30が無い点は飛ばして数える（増幅なしで埋めない）', () => {
    const result = predictStations(SOURCE, [
      station({ name: 'あり', avs30: 300 }),
      station({ name: 'なし', avs30: null }),
    ]);
    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]!.station.name).toBe('あり');
    expect(result.skipped).toBe(1);
  });

  it('水域の AVS=0 も欠測として扱う（増幅が発散する）', () => {
    // J-SHISは沿岸海域・湖沼・河道で 0 を返す。座標の丸めで海側の
    // メッシュを指した海岸沿いの点で起きる
    const result = predictStations(SOURCE, [
      station({ name: '海域', avs30: 0, jname: '沿岸海域' }),
      station({ name: '陸', avs30: 300 }),
    ]);
    expect(result.skipped).toBe(1);
    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]!.station.name).toBe('陸');
  });

  it('深さ150km超では1点も出さない', () => {
    const result = predictStations(
      { ...SOURCE, depthKm: 200 },
      [station({}), station({ name: '別の点', lat: 35.5 })],
    );
    expect(result.stations).toEqual([]);
    expect(result.skipped).toBe(0);
  });
});

describe('地域ごとの最大', () => {
  it('地域の中で一番強い点を代表にする', () => {
    const { stations } = predictStations(SOURCE, [
      station({ name: '弱い点', area: 'A', lat: 36.0, avs30: 600 }),
      station({ name: '強い点', area: 'A', lat: 35.2, avs30: 200 }),
      station({ name: '別地域', area: 'B', lat: 36.5, avs30: 400 }),
    ]);
    const areas = maxByArea(stations);

    expect(areas.get('A')!.station.name).toBe('強い点');
    expect(areas.get('B')!.station.name).toBe('別地域');
    expect([...areas.keys()].sort()).toEqual(['A', 'B']);
  });

  it('地域が無い点は集約から外す', () => {
    const { stations } = predictStations(SOURCE, [
      station({ name: '地域なし', area: null }),
    ]);
    expect(maxByArea(stations).size).toBe(0);
  });

  it('全体の最大も取れる', () => {
    const { stations } = predictStations(SOURCE, [
      station({ name: '遠い', lat: 36.5 }),
      station({ name: '直近', lat: 35.05, avs30: 200 }),
    ]);
    expect(maxStation(stations)!.station.name).toBe('直近');
    expect(maxStation([])).toBeNull();
  });
});
