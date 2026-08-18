import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isPlumMethod,
  shouldDrawWaveCircles,
  surfaceStatus,
} from '../src/lib/waveCircles';
import {
  parseTravelTimeTable,
  surfaceArrivalDelay,
  waveRadii,
} from '../src/lib/travelTime';
import { geodesicCircle, surfaceDistanceKm } from '../src/lib/geo';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { EewEvent } from '../src/types';

const NOW = Date.parse('2026-08-17T05:00:00Z');

/** 実データと同じ形の電文から作る（正規化後のオブジェクトを直接組まない） */
function eew(patch: Record<string, unknown> = {}): EewEvent {
  return parseWolfxMessage(
    {
      type: 'jma_eew',
      Title: '緊急地震速報（予報）',
      EventID: '20260817140000',
      Serial: 3,
      AnnouncedTime: '2026/08/17 14:00:10',
      OriginTime: '2026/08/17 14:00:00',
      Hypocenter: '茨城県沖',
      Latitude: 36.5,
      Longitude: 141.0,
      Magunitude: 6.1,
      Depth: 40,
      MaxIntensity: '4',
      Accuracy: {
        Epicenter: 'IPF 法（5 点以上）',
        Depth: 'IPF 法（5 点以上）',
        Magnitude: '全点全相',
      },
      WarnArea: [],
      isSea: true,
      isTraining: false,
      isAssumption: false,
      isWarn: false,
      isFinal: false,
      isCancel: false,
      OriginalText: '37 03 00 ...',
      ...patch,
    },
    { receivedAt: NOW, now: NOW },
  ) as EewEvent;
}

describe('深さ', () => {
  it('深発地震でも描く', () => {
    // 走時表は700kmまで値を持つ。深いぶん円の出現が遅れるだけ
    for (const depth of [150, 151, 170, 400, 700]) {
      expect(shouldDrawWaveCircles(eew({ Depth: depth })), String(depth)).toBe(true);
    }
  });

  it('浅い地震でも描く', () => {
    expect(shouldDrawWaveCircles(eew({ Depth: 0 }))).toBe(true);
    expect(shouldDrawWaveCircles(eew({ Depth: 10 }))).toBe(true);
  });

  it('深さ不明では描かない（半径を引けない）', () => {
    expect(shouldDrawWaveCircles(eew({ Depth: null }))).toBe(false);
  });
});

describe('PLUM法の判定', () => {
  /**
   * 生電文 RK の1桁目が震央の確からしさ。9 がPLUM法。
   * 実データで確認できているのは 4（IPF法5点以上）まで。
   * 9 の電文は観測できていないので、ここは実データの形に 9 を差し込んだもの。
   */
  const PLUM_TEXT =
    '37 03 00 260817140010 C11 260817140000 ND20260817140000 NCN903 ' +
    'JD////////////// JN/// 301 N365 E1410 010 51 5- RK94209 RT01/// RC0//// 9999=';

  it('電文のコード（RKの1桁目=9）でPLUM法と判定する', () => {
    const e = eew({
      OriginalText: PLUM_TEXT,
      // 和訳の文字列がどう来ても、コードが優先される
      Accuracy: { Epicenter: '', Depth: '', Magnitude: '' },
    });
    expect(e.accuracy?.epicenterCode).toBe(9);
    expect(isPlumMethod(e)).toBe(true);
    expect(e.epicenterReliable).toBe(false);
  });

  it('実データ（RK=4）はPLUM法ではない', () => {
    const e = eew();
    expect(isPlumMethod(e)).toBe(false);
  });

  it('電文が無い配信元では文字列で判定する', () => {
    const e = eew({
      OriginalText: null,
      Accuracy: { Epicenter: 'PLUM 法', Depth: '', Magnitude: '' },
    });
    expect(e.accuracy?.epicenterCode).toBeNull();
    expect(isPlumMethod(e)).toBe(true);
  });

  it('埋め字（RK/////）でもコードを捏造しない', () => {
    const e = eew({
      OriginalText: '37 03 00 ... RK///// RT01/// 9999=',
      Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: '', Magnitude: '' },
    });
    expect(e.accuracy?.epicenterCode).toBeNull();
    expect(isPlumMethod(e)).toBe(false);
  });

  it('PLUM法では予報円を描かない（震源を決める手法ではない）', () => {
    const plum = eew({
      OriginalText: PLUM_TEXT,
      Accuracy: { Epicenter: 'PLUM 法', Depth: 'PLUM 法', Magnitude: '' },
    });
    expect(isPlumMethod(plum)).toBe(true);
    // 観測された揺れから周辺の揺れを予測するもので、震源から広がる波ではない
    expect(shouldDrawWaveCircles(plum)).toBe(false);
    expect(plum.epicenterReliable).toBe(false);
  });

  it('全角表記のPLUMも拾う', () => {
    const plum = eew({
      Accuracy: { Epicenter: 'ＰＬＵＭ法', Depth: '', Magnitude: '' },
    });
    expect(isPlumMethod(plum)).toBe(true);
  });

  it('IPF法など震源が確定している手法では描く', () => {
    for (const method of ['IPF 法（5 点以上）', 'ＩＰＦ法（１点）', '防災科研システム']) {
      const e = eew({ Accuracy: { Epicenter: method, Depth: '', Magnitude: '' } });
      expect(isPlumMethod(e), method).toBe(false);
      expect(shouldDrawWaveCircles(e), method).toBe(true);
    }
  });

  it('地域ごとのPLUM表記（Arrive）は震源決定手法ではない', () => {
    // 実データ: 震源は IPF 法だが、地域の Arrive に「PLUM 法による予測」と入る
    const e = eew({
      Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: '', Magnitude: '' },
      WarnArea: [
        {
          Chiiki: '栃木県南部',
          Shindo1: '5弱',
          Shindo2: '5弱',
          Time: '100639',
          Type: '警報',
          Arrive: '主要動到達時刻の予測なし（PLUM 法による予測）',
        },
      ],
    });
    expect(isPlumMethod(e)).toBe(false);
    expect(shouldDrawWaveCircles(e)).toBe(true);
  });
});

describe('電文の種別', () => {
  it('予報でも警報でも描く（判定に混ぜない）', () => {
    expect(shouldDrawWaveCircles(eew({ isWarn: false }))).toBe(true);
    expect(
      shouldDrawWaveCircles(eew({ isWarn: true, Title: '緊急地震速報（警報）' })),
    ).toBe(true);
  });

  it('取消報では描かない', () => {
    expect(shouldDrawWaveCircles(eew({ isCancel: true }))).toBe(false);
  });
});

describe('震源要素が足りない場合', () => {
  it('震央が無ければ描かない', () => {
    expect(shouldDrawWaveCircles(eew({ Latitude: null, Longitude: null }))).toBe(false);
  });

  it('発震時刻が無ければ描かない（経過秒数の基準が無い）', () => {
    expect(shouldDrawWaveCircles(eew({ OriginTime: null }))).toBe(false);
  });
});

describe('測地線円', () => {
  it('中心から等距離の点を返す', () => {
    const points = geodesicCircle(36.5, 141, 300, 128);
    expect(points).toHaveLength(128);
    for (const [lon, lat] of points) {
      expect(surfaceDistanceKm(36.5, 141, lat, lon)).toBeCloseTo(300, 1);
    }
  });

  it('投影平面の真円ではない（経度方向に広がる）', () => {
    const points = geodesicCircle(36.5, 141, 500, 4);
    const lonSpan = Math.abs(points[1]![0] - points[3]![0]);
    const latSpan = Math.abs(points[0]![1] - points[2]![1]);
    // 同じ地表距離でも、経度方向のほうが度数では大きくなる
    expect(lonSpan).toBeGreaterThan(latSpan);
  });

  it('半径0や不正値では点を作らない', () => {
    expect(geodesicCircle(36.5, 141, 0)).toEqual([]);
    expect(geodesicCircle(36.5, 141, -10)).toEqual([]);
    expect(geodesicCircle(Number.NaN, 141, 100)).toEqual([]);
  });
});

describe('S波が震央直上に出るまでの進み具合', () => {
  const table = parseTravelTimeTable(
    readFileSync(`${process.cwd()}/public/assets/tjma2001.txt`, 'utf8'),
  );
  // 深さ60km: S波は約15.3秒で震央直上に出る
  const delay = surfaceArrivalDelay(table, 60);

  it('発震からS波が地表に出るまでを一本で数える', () => {
    expect(surfaceStatus(table, 60, 0)).toEqual({
      progress: 0,
      remainSec: delay.s!,
    });

    const half = surfaceStatus(table, 60, delay.s! / 2)!;
    expect(half.progress).toBeCloseTo(0.5, 6);
    expect(half.remainSec).toBeCloseTo(delay.s! / 2, 6);
  });

  it('P波が地表に出ても数え直さない（見るのはS波だけ）', () => {
    const before = surfaceStatus(table, 60, delay.p! - 0.01)!;
    const after = surfaceStatus(table, 60, delay.p! + 0.01)!;
    // P波の到達をまたいでも進み具合は連続している
    expect(after.progress).toBeGreaterThan(before.progress);
    expect(after.progress - before.progress).toBeLessThan(0.01);
  });

  it('リングが一周する時刻とS波の予報円が出る時刻は同じ', () => {
    // 進み具合が1に届く直前は円がまだ無い
    expect(waveRadii(table, 60, delay.s! - 0.01).s).toBeNull();
    expect(surfaceStatus(table, 60, delay.s! - 0.01)!.progress).toBeGreaterThan(0.999);
    // 過ぎたらS波の円が出て、リングは消える
    expect(waveRadii(table, 60, delay.s! + 0.01).s).not.toBeNull();
    expect(surfaceStatus(table, 60, delay.s! + 0.01)).toBeNull();
  });

  it('地表に出たら出さない（円が状態を語る）', () => {
    expect(surfaceStatus(table, 60, delay.s!)).toBeNull();
    expect(surfaceStatus(table, 60, delay.s! + 30)).toBeNull();
  });

  it('深さ0kmでは出さない（待ちが無い。走時0秒で地表に出ている）', () => {
    expect(surfaceArrivalDelay(table, 0).s).toBe(0);
    expect(surfaceStatus(table, 0, 0)).toBeNull();
  });

  it('進み具合は必ず0〜1に収まる', () => {
    for (const depth of [10, 60, 170, 400]) {
      const s = surfaceArrivalDelay(table, depth).s;
      if (s === null) continue;
      for (const t of [0, s / 3, s - 0.001]) {
        const status = surfaceStatus(table, depth, t)!;
        expect(status.progress, `${depth}km ${t}s`).toBeGreaterThanOrEqual(0);
        expect(status.progress, `${depth}km ${t}s`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('時計がずれて発震が未来になっても、進み具合は0未満にならない', () => {
    expect(surfaceStatus(table, 60, -5)!.progress).toBe(0);
  });

  it('深さが表の外なら出さない', () => {
    expect(surfaceStatus(table, 900, 5)).toBeNull();
    expect(surfaceStatus(table, 60, Number.NaN)).toBeNull();
  });
});
