import { describe, expect, it } from 'vitest';
import {
  MAX_PREDICTION_DEPTH_KM,
  amplificationFromAvs30,
  arv400ToReference,
  faultLengthKm,
  formatPredictionRange,
  measuredIntensity,
  pgv600,
  predictIntensity,
  roundSource,
  shortestDistanceKm,
  toMomentMagnitude,
} from '../src/lib/intensityPrediction';
import { intensityFromMeasured } from '../src/adapters/intensity';
import { surfaceDistanceKm } from '../src/lib/geo';

/**
 * 気象庁「緊急地震速報検討委員会 資料2-1（平成20年3月18日）」の式。
 * 資料の計算例をそのまま固定する。
 */

describe('資料の計算例（Mjma 7.0 / 深さ20km / 震央距離50km / AVS30 250）', () => {
  const MW = 6.829;

  it('第0段 マグニチュード変換', () => {
    expect(toMomentMagnitude(7.0)).toBeCloseTo(6.829, 3);
  });

  it('第1段 断層長と最短距離', () => {
    expect(faultLengthKm(MW)).toBeCloseTo(36.7, 1);
    const r = Math.hypot(50, 20);
    expect(r).toBeCloseTo(53.85, 2);
    expect(shortestDistanceKm(r, MW)).toBeCloseTo(35.5, 1);
  });

  it('第2段 基準基盤上の最大速度', () => {
    expect(pgv600(MW, 20, 35.505)).toBeCloseTo(11.08, 2);
    // 点震源の距離（下限側）
    expect(pgv600(MW, 20, 53.8516)).toBeCloseTo(7.13, 2);
  });

  it('第3段 地盤増幅', () => {
    expect(amplificationFromAvs30(250)).toBeCloseTo(1.782, 3);
    expect(11.08 * amplificationFromAvs30(250)).toBeCloseTo(19.7, 1);
  });

  it('第4段 計測震度', () => {
    expect(measuredIntensity(19.75)).toBeCloseTo(4.91, 2);
    expect(measuredIntensity(12.7)).toBeCloseTo(4.58, 2);
  });

  it('通しで計算すると資料の値になる', () => {
    // 震央から真東へ50km離れた地点
    const source = { lat: 35.0, lon: 139.0, depthKm: 20, magnitude: 7.0 };
    const site = siteAtDistance(source.lat, source.lon, 50);
    const p = predictIntensity(source, { ...site, avs30: 250 })!;

    expect(p.epicentralDistanceKm).toBeCloseTo(50, 1);
    expect(p.mw).toBeCloseTo(6.829, 3);
    expect(p.faultLengthKm).toBeCloseTo(36.7, 1);
    expect(p.hypocentralDistanceKm).toBeCloseTo(53.85, 1);

    expect(p.upper.distanceKm).toBeCloseTo(35.5, 1);
    expect(p.upper.pgv600).toBeCloseTo(11.08, 1);
    expect(p.upper.pgv).toBeCloseTo(19.7, 1);
    expect(p.upper.measured).toBeCloseTo(4.91, 2);
    expect(p.upper.intensity.label).toBe('5弱');

    expect(p.lower.pgv600).toBeCloseTo(7.13, 1);
    expect(p.lower.pgv).toBeCloseTo(12.7, 1);
    expect(p.lower.measured).toBeCloseTo(4.58, 2);
    expect(p.lower.intensity.label).toBe('5弱');

    // 上下が同じ階級なので一点表示になる
    expect(formatPredictionRange(p)).toBe('5弱');
  });
});

describe('震源要素の丸め', () => {
  it('緯度経度は0.1度、深さは10km単位', () => {
    expect(roundSource({ lat: 35.67, lon: 139.44, depthKm: 23, magnitude: 6 })).toEqual({
      lat: 35.7,
      lon: 139.4,
      depthKm: 20,
      magnitude: 6,
    });
  });

  it('深さ0kmは無いので10kmを下限にする', () => {
    expect(roundSource({ lat: 35, lon: 139, depthKm: 0, magnitude: 6 }).depthKm).toBe(10);
    expect(roundSource({ lat: 35, lon: 139, depthKm: 4, magnitude: 6 }).depthKm).toBe(10);
  });

  it('報ごとの深さの微動で予測が跳ねない', () => {
    const site = { lat: 35.5, lon: 139.5, avs30: 400 };
    const a = predictIntensity({ lat: 35, lon: 139, depthKm: 18, magnitude: 6.5 }, site)!;
    const b = predictIntensity({ lat: 35, lon: 139, depthKm: 22, magnitude: 6.5 }, site)!;
    // どちらも深さ20kmに丸められる
    expect(a.upper.measured).toBe(b.upper.measured);
  });

  it('丸めを切ることもできる', () => {
    const site = { lat: 35.5, lon: 139.5 };
    const rounded = predictIntensity({ lat: 35, lon: 139, depthKm: 18, magnitude: 6.5 }, site)!;
    const raw = predictIntensity(
      { lat: 35, lon: 139, depthKm: 18, magnitude: 6.5 },
      site,
      { round: false },
    )!;
    expect(raw.upper.measured).not.toBe(rounded.upper.measured);
  });
});

describe('適用制限', () => {
  it('深さ150kmを超えたら予測しない', () => {
    const site = { lat: 35.5, lon: 139.5, avs30: 400 };
    expect(
      predictIntensity({ lat: 35, lon: 139, depthKm: 160, magnitude: 7 }, site),
    ).toBeNull();
    expect(MAX_PREDICTION_DEPTH_KM).toBe(150);
  });

  it('深さ150kmちょうどは予測する', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 150, magnitude: 7 },
      { lat: 35.5, lon: 139.5, avs30: 400 },
    );
    expect(p).not.toBeNull();
  });

  it('距離減衰式の想定（50km以浅）を超えたら印を付ける', () => {
    const site = { lat: 35.5, lon: 139.5, avs30: 400 };
    expect(
      predictIntensity({ lat: 35, lon: 139, depthKm: 40, magnitude: 7 }, site)!
        .beyondAttenuationDepth,
    ).toBe(false);
    expect(
      predictIntensity({ lat: 35, lon: 139, depthKm: 120, magnitude: 7 }, site)!
        .beyondAttenuationDepth,
    ).toBe(true);
  });

  it('回帰範囲（震度4以上）を下回ったら印を付ける', () => {
    const far = predictIntensity(
      { lat: 35, lon: 139, depthKm: 20, magnitude: 5 },
      siteAtDistance(35, 139, 200),
    )!;
    expect(far.upper.measured).toBeLessThan(3.5);
    expect(far.belowRegressionRange).toBe(true);
  });

  it('NaN を持ち込まない', () => {
    expect(
      predictIntensity(
        { lat: Number.NaN, lon: 139, depthKm: 20, magnitude: 7 },
        { lat: 35, lon: 139 },
      ),
    ).toBeNull();
  });
});

describe('断層近傍', () => {
  it('断層長の半分より内側では最短距離を3kmで止める', () => {
    const mw = toMomentMagnitude(8.0);
    // L/2 は50km以上。震源直上でも負にならない
    expect(shortestDistanceKm(10, mw)).toBe(3);
    expect(shortestDistanceKm(0, mw)).toBe(3);
  });

  it('震源直上でも飽和項が効いて発散しない', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 10, magnitude: 8.0 },
      { lat: 35, lon: 139, avs30: 250 },
    )!;
    // 最短距離は下限の3kmまで詰まる
    expect(p.upper.distanceKm).toBe(3);
    // 飽和項 0.0028·10^(0.5Mw) が分母を底上げするので、値は有限に収まる
    expect(Number.isFinite(p.upper.measured)).toBe(true);
    expect(p.upper.measured).toBeCloseTo(6.32, 1);
    expect(p.upper.intensity.label).toBe('6強');
  });
});

describe('上限と下限', () => {
  it('最短距離のほうが強く、点震源のほうが弱い', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 20, magnitude: 7.5 },
      siteAtDistance(35, 139, 80),
    )!;
    expect(p.upper.measured).toBeGreaterThan(p.lower.measured);
    expect(p.upper.distanceKm).toBeLessThan(p.lower.distanceKm);
  });

  it('階級が違えば「○○から○○」の形にする', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 10, magnitude: 7.5 },
      { ...siteAtDistance(35, 139, 60), avs30: 300 },
    )!;
    const text = formatPredictionRange(p);
    if (p.upper.intensity.value !== p.lower.intensity.value) {
      expect(text).toContain('から');
    } else {
      expect(text).toBe(p.upper.intensity.label);
    }
  });
});

describe('地盤増幅', () => {
  it('基準基盤そのものなら増幅なし', () => {
    expect(amplificationFromAvs30(600)).toBeCloseTo(1, 6);
  });

  it('柔らかいほど増幅する', () => {
    expect(amplificationFromAvs30(200)).toBeGreaterThan(amplificationFromAvs30(400));
    expect(amplificationFromAvs30(1000)).toBeLessThan(1);
  });

  it('気象庁の2段構え（600→700→AVS）と1段でまとめた式が一致する', () => {
    const avs = 250;
    const twoStep = (600 / 700) ** 0.66 * (700 / avs) ** 0.66;
    expect(amplificationFromAvs30(avs)).toBeCloseTo(twoStep, 12);
    // 資料の 0.90 は (600/700)^0.66 のこと
    expect((600 / 700) ** 0.66).toBeCloseTo(0.903, 3);
  });

  it('J-SHIS V4 の ARV（Vs=400基準）を600基準に直す', () => {
    expect(arv400ToReference(1)).toBeCloseTo(1.307, 3);
  });

  it('AVS30 を省略したら増幅なしとして扱う', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 20, magnitude: 7 },
      siteAtDistance(35, 139, 50),
    )!;
    expect(p.amplification).toBe(1);
    expect(p.upper.pgv).toBeCloseTo(p.upper.pgv600, 10);
  });

  it('増幅率を直接渡せる（ARVを持っている場合）', () => {
    const p = predictIntensity(
      { lat: 35, lon: 139, depthKm: 20, magnitude: 7 },
      { ...siteAtDistance(35, 139, 50), avs30: 250 },
      { amplification: 2 },
    )!;
    // avs30 より amplification が優先される
    expect(p.amplification).toBe(2);
  });
});

describe('震度階級への変換', () => {
  it('境界値が表どおり', () => {
    const cases: [number, string][] = [
      [0.4, '0'],
      [0.5, '1'],
      [1.5, '2'],
      [2.5, '3'],
      [3.5, '4'],
      [4.5, '5弱'],
      [5.0, '5強'],
      [5.5, '6弱'],
      [6.0, '6強'],
      [6.5, '7'],
      [7.9, '7'],
    ];
    for (const [measured, label] of cases) {
      expect(intensityFromMeasured(measured).label, String(measured)).toBe(label);
    }
  });

  it('境界のすぐ下は下の階級', () => {
    expect(intensityFromMeasured(4.499).label).toBe('4');
    expect(intensityFromMeasured(4.999).label).toBe('5弱');
  });
});

/** 中心から東へ指定距離だけ離れた地点 */
function siteAtDistance(lat: number, lon: number, km: number): { lat: number; lon: number } {
  const deltaLon = km / (111.195 * Math.cos((lat * Math.PI) / 180));
  const site = { lat, lon: lon + deltaLon };
  // 概算で作った点なので、実際の距離を確かめてから使う
  expect(surfaceDistanceKm(lat, lon, site.lat, site.lon)).toBeCloseTo(km, 0);
  return site;
}
