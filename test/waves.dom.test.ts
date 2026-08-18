// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WaveCircles } from '../src/ui/waves';
import { parseTravelTimeTable, type TravelTimeTable } from '../src/lib/travelTime';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { EewEvent } from '../src/types';

/** 報の更新・同時進行・アニメーションの止め方を、DOMの上で確かめる */

const table: TravelTimeTable = parseTravelTimeTable(
  readFileSync(`${process.cwd()}/public/assets/tjma2001.txt`, 'utf8'),
);

const ORIGIN = '2026/08/17 14:00:00';
const ORIGIN_MS = Date.parse('2026-08-17T05:00:00Z');

function eew(patch: Record<string, unknown> = {}): EewEvent {
  return parseWolfxMessage(
    {
      EventID: 'E1',
      Serial: 1,
      Title: '緊急地震速報（予報）',
      AnnouncedTime: '2026/08/17 14:00:10',
      OriginTime: ORIGIN,
      Hypocenter: '茨城県沖',
      Latitude: 36.5,
      Longitude: 141.0,
      Magunitude: 6.1,
      Depth: 40,
      MaxIntensity: '4',
      Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: '', Magnitude: '' },
      WarnArea: [],
      isCancel: false,
      ...patch,
    },
    { receivedAt: ORIGIN_MS, now: ORIGIN_MS },
  ) as EewEvent;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

let layer: SVGGElement;
let now = ORIGIN_MS;
let frames: (() => void)[];

function makeWaves(): WaveCircles {
  frames = [];
  return new WaveCircles(layer, {
    table: () => table,
    now: () => now,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
  });
}

const groups = () => [...layer.querySelectorAll('g.wave')];
const pathOf = (eventId: string, phase: 'p' | 's') =>
  layer.querySelector<SVGPathElement>(`g[data-event="${eventId}"] .wave__${phase}`)!;

/** 描かれた円のおおよその半径（画面座標） */
function drawnRadius(el: SVGPathElement): number | null {
  const d = el.getAttribute('d');
  if (!d) return null;
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return (Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys))) / 4;
}

beforeEach(() => {
  document.body.replaceChildren();
  const svg = document.createElementNS(SVG_NS, 'svg');
  layer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(layer);
  document.body.appendChild(svg);
  now = ORIGIN_MS;
});

describe('報の更新への追従', () => {
  it('報が更新されても要素を作り直さず、半径は連続して増える', () => {
    const waves = makeWaves();

    now = ORIGIN_MS + 20_000;
    waves.update([eew({ Serial: 1 })]);
    const element = pathOf('E1', 's');
    const r20 = drawnRadius(element)!;

    // 第5報で震源が動く
    now = ORIGIN_MS + 40_000;
    waves.update([
      eew({ Serial: 5, Latitude: 37.2, Longitude: 141.6, Depth: 50 }),
    ]);

    // 同じ要素のまま（アニメーションを切らさない）
    expect(pathOf('E1', 's')).toBe(element);
    expect(groups()).toHaveLength(1);
    expect(drawnRadius(element)!).toBeGreaterThan(r20);
  });

  it('震源が動いたら円の中心も動く', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 60_000;
    waves.update([eew()]);
    const before = center(pathOf('E1', 'p'));

    waves.update([eew({ Serial: 2, Latitude: 33.0, Longitude: 135.0 })]);
    const after = center(pathOf('E1', 'p'));
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(10);
  });

  it('更新のたびに走時表を引き直す（前回からの外挿をしない）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 60_000;
    waves.update([eew({ Depth: 10 })]);
    const shallow = drawnRadius(pathOf('E1', 's'))!;

    // 同じ時刻のまま深さだけ変わると、半径もその深さの走時に従う
    waves.update([eew({ Serial: 2, Depth: 140 })]);
    const deep = drawnRadius(pathOf('E1', 's'))!;
    expect(deep).not.toBeCloseTo(shallow, 1);
  });
});

describe('複数のEEWの同時進行', () => {
  it('イベントIDごとに独立して描く', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([
      eew({ EventID: 'A', Latitude: 36.5, Longitude: 141 }),
      eew({ EventID: 'B', Latitude: 33.0, Longitude: 132, Depth: 10 }),
    ]);

    expect(groups()).toHaveLength(2);
    expect(pathOf('A', 's').getAttribute('d')).not.toBe(
      pathOf('B', 's').getAttribute('d'),
    );
  });

  it('片方が消えても、もう片方は影響を受けない', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([eew({ EventID: 'A' }), eew({ EventID: 'B', Latitude: 33 })]);
    const keep = pathOf('B', 's').getAttribute('d');

    waves.update([eew({ EventID: 'B', Latitude: 33 })]);
    expect(groups()).toHaveLength(1);
    expect(layer.querySelector('g[data-event="A"]')).toBeNull();
    expect(pathOf('B', 's').getAttribute('d')).toBe(keep);
  });
});

describe('描画条件との連動', () => {
  it('取消報を受けたら円を即座に消す', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([eew()]);
    expect(groups()).toHaveLength(1);

    waves.update([eew({ Serial: 2, isCancel: true })]);
    expect(groups()).toHaveLength(0);
  });

  it('深発地震でも描く。深いぶん円の出現が遅れる', () => {
    const waves = makeWaves();
    // 深さ170kmでは震央直上への到達に25秒前後かかる
    now = ORIGIN_MS + 10_000;
    waves.update([eew({ Depth: 170 })]);
    expect(groups()).toHaveLength(1);
    expect(pathOf('E1', 'p').getAttribute('d')).toBeNull();

    now = ORIGIN_MS + 60_000;
    waves.redraw();
    expect(pathOf('E1', 'p').getAttribute('d')).not.toBeNull();
  });

  it('PLUM法では円を作らない（震源から広がる波ではない）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([
      eew({ Accuracy: { Epicenter: 'PLUM 法', Depth: '', Magnitude: '' } }),
    ]);
    expect(groups()).toHaveLength(0);
  });

  it('報の更新でPLUM法から切り替わったら円が出る', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([
      eew({ Accuracy: { Epicenter: 'PLUM 法', Depth: '', Magnitude: '' } }),
    ]);
    expect(groups()).toHaveLength(0);

    waves.update([eew({ Serial: 2 })]);
    expect(groups()).toHaveLength(1);
    expect(pathOf('E1', 's').getAttribute('d')).not.toBeNull();
  });

  it('まだ地表に届いていない間は、要素はあってもパスを描かない', () => {
    const waves = makeWaves();
    // 深さ40kmの震央直上への到達は約6秒後
    now = ORIGIN_MS + 1_000;
    waves.update([eew()]);
    expect(groups()).toHaveLength(1);
    expect(pathOf('E1', 'p').getAttribute('d')).toBeNull();
    expect(pathOf('E1', 'p').hasAttribute('hidden')).toBe(true);

    now = ORIGIN_MS + 30_000;
    waves.redraw();
    expect(pathOf('E1', 'p').getAttribute('d')).not.toBeNull();
  });

  it('走時表が無ければ描かない（0kmの円を出さない）', () => {
    const waves = new WaveCircles(layer, {
      table: () => null,
      now: () => ORIGIN_MS + 30_000,
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    waves.update([eew()]);
    expect(pathOf('E1', 's').getAttribute('d')).toBeNull();
  });
});

describe('アニメーション', () => {
  it('進行中のEEWがある間だけループする', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;

    waves.update([eew()]);
    expect(frames).toHaveLength(1);

    // 1フレーム進めると次のフレームが積まれる
    frames.pop()!();
    expect(frames).toHaveLength(1);

    // 対象が無くなったら止まる
    waves.update([]);
    frames.pop()!();
    expect(frames).toHaveLength(0);
  });

  it('フレームごとに半径を引き直す', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 20_000;
    waves.update([eew()]);
    const before = drawnRadius(pathOf('E1', 's'))!;

    now = ORIGIN_MS + 50_000;
    frames.pop()!();
    expect(drawnRadius(pathOf('E1', 's'))!).toBeGreaterThan(before);
  });
});

function center(el: SVGPathElement): { x: number; y: number } {
  const nums = el.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return {
    x: (Math.max(...xs) + Math.min(...xs)) / 2,
    y: (Math.max(...ys) + Math.min(...ys)) / 2,
  };
}

describe('震央のリング（S波が地表に出るまでの進み具合）', () => {
  const ring = (eventId: string) =>
    layer.querySelector<SVGCircleElement>(`g[data-event="${eventId}"] .wave__ring`)!;
  const track = (eventId: string) =>
    layer.querySelector<SVGCircleElement>(
      `g[data-event="${eventId}"] .wave__ring-track`,
    )!;
  /** 0〜1。dashoffset から逆算する */
  const progress = (el: SVGCircleElement) =>
    1 - Number(el.getAttribute('stroke-dashoffset')) /
      Number(el.getAttribute('stroke-dasharray'));

  // 深さ170km: S波は約42秒で震央直上に出る
  const deep = { Depth: 170 };

  it('円がまだ無いあいだ、震央の周りにリングを出す', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 21_000;
    waves.update([eew(deep)]);

    // S波の円はまだ無い
    expect(pathOf('E1', 's').getAttribute('d')).toBeNull();
    // リングは半分ほど進んでいる
    expect(ring('E1').hasAttribute('hidden')).toBe(false);
    expect(track('E1').hasAttribute('hidden')).toBe(false);
    expect(progress(ring('E1'))).toBeGreaterThan(0.3);
    expect(progress(ring('E1'))).toBeLessThan(0.7);
  });

  it('時間が進むとリングが伸びる', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 6_000;
    waves.update([eew(deep)]);
    const before = progress(ring('E1'));

    now = ORIGIN_MS + 30_000;
    frames.pop()!();
    expect(progress(ring('E1'))).toBeGreaterThan(before);
  });

  it('P波の円が出ても数え直さない（見るのはS波だけ）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 30_000;
    waves.update([eew(deep)]);

    // P波の円は出ている。S波はまだ
    expect(pathOf('E1', 'p').getAttribute('d')).not.toBeNull();
    expect(pathOf('E1', 's').getAttribute('d')).toBeNull();
    // 発震からの通算なので、7割ほどまで進んでいる
    expect(progress(ring('E1'))).toBeGreaterThan(0.6);
    expect(ring('E1').hasAttribute('hidden')).toBe(false);
  });

  it('S波の円が出たらリングを消す（円が状態を語る）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 60_000;
    waves.update([eew(deep)]);

    expect(pathOf('E1', 's').getAttribute('d')).not.toBeNull();
    expect(ring('E1').hasAttribute('hidden')).toBe(true);
    expect(track('E1').hasAttribute('hidden')).toBe(true);
  });

  it('12時から反時計回りに満たす', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 21_000;
    waves.update([eew(deep)]);

    const el = ring('E1');
    const cx = Number(el.getAttribute('cx'));
    // rotate(-90) で始点を12時へ、鏡映で向きを反時計回りにする。
    // 鏡映は縦軸（x = cx）まわりなので translate は cx の2倍
    expect(el.getAttribute('transform')).toBe(
      `translate(${(cx * 2).toFixed(2)} 0) scale(-1 1) rotate(-90 ${cx.toFixed(2)} ${Number(
        el.getAttribute('cy'),
      ).toFixed(2)})`,
    );
  });

  it('破線の刻みは一周ぶんちょうど（円の全周に破片が散らない）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 21_000;
    waves.update([eew(deep)]);

    const el = ring('E1');
    const r = Number(el.getAttribute('r'));
    // 刻みが円周と1対1でないと、破線が繰り返して赤い破片が全周に出る。
    // 半径と同じ座標系で持つこと（CSSの non-scaling-stroke は使えない）
    expect(Number(el.getAttribute('stroke-dasharray'))).toBeCloseTo(2 * Math.PI * r, 1);
    // 線の太さも座標系の値。CSSには置かない
    expect(Number(el.getAttribute('stroke-width'))).toBeGreaterThan(0);
    expect(Number(track('E1').getAttribute('stroke-width'))).toBeGreaterThan(0);
  });

  it('拡大しても見かけの大きさを変えない（倍率で割り戻す）', () => {
    frames = [];
    let scale = 1;
    const waves = new WaveCircles(layer, {
      table: () => table,
      now: () => now,
      scale: () => scale,
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => {},
    });
    now = ORIGIN_MS + 21_000;
    waves.update([eew(deep)]);
    const full = Number(ring('E1').getAttribute('r'));

    const fullWidth = Number(ring('E1').getAttribute('stroke-width'));

    // 表示範囲を半分に縮める（＝2倍に拡大する）と、座標系の半径も太さも半分になる
    scale = 0.5;
    waves.redraw();
    expect(Number(ring('E1').getAttribute('r'))).toBeCloseTo(full / 2, 2);
    expect(Number(ring('E1').getAttribute('stroke-width'))).toBeCloseTo(fullWidth / 2, 2);
    // 刻みも半径に追従する
    expect(Number(ring('E1').getAttribute('stroke-dasharray'))).toBeCloseTo(
      2 * Math.PI * (full / 2),
      1,
    );
  });

  it('リングは震央に付く（円の中心と同じ）', () => {
    const waves = makeWaves();
    now = ORIGIN_MS + 21_000;
    waves.update([eew(deep)]);
    const cx = Number(ring('E1').getAttribute('cx'));

    now = ORIGIN_MS + 60_000;
    frames.pop()!();
    // 同じ震源なら、S波の円の中心と一致する
    expect(center(pathOf('E1', 's')).x).toBeCloseTo(cx, 0);
  });

  it('走時表が無ければ出さない（待ち時間が分からない）', () => {
    const waves = new WaveCircles(layer, {
      table: () => null,
      now: () => ORIGIN_MS + 21_000,
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    waves.update([eew(deep)]);
    expect(ring('E1').hasAttribute('hidden')).toBe(true);
  });
});
