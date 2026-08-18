import type { EewEvent } from '../types';
import type { TravelTimeTable } from '../lib/travelTime';
import { waveRadii } from '../lib/travelTime';
import { shouldDrawWaveCircles, surfaceStatus } from '../lib/waveCircles';
import { geodesicCircle } from '../lib/geo';
import { project } from './geo';

/**
 * P波・S波の予報円。
 *
 * 半径は**地震発生時刻からの経過秒数**で走時表から引き直す。発表時刻ではない。
 * 前回の半径からの外挿はしない（報で震源が動いても常に正しい半径になる）。
 *
 * 複数の地震のEEWが同時に進行しうるので、状態はイベントIDごとに持つ。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 円周の分割数。数百kmの円でも多角形に見えない程度 */
const SEGMENTS = 128;

/**
 * 震央の印を囲むリングの半径（拡大率1のときの画面上の大きさ）。
 * ×印の腕は 11、対角で約15.6まで伸びる。震央の印と重なって読めなくならないよう、
 * その倍ほど外側に置く（S波の待ちは×印と同じ赤なので、近いと見分けが付かない）。
 */
const RING_RADIUS = 30;

/** リングの線の太さ（拡大率1のときの画面上の太さ）。溝は細く */
const RING_WIDTH = 4;
const RING_TRACK_WIDTH = 3;

interface WaveCircleState {
  eventId: string;
  lat: number;
  lon: number;
  depthKm: number;
  originAtMs: number;
  /** この地震のためのSVG要素。報の更新では作り直さない */
  pPath: SVGPathElement;
  sPath: SVGPathElement;
  /** 震央直上に波が出るまでの進み具合（震央の印を囲むリング） */
  ringTrack: SVGCircleElement;
  ringArc: SVGCircleElement;
  group: SVGGElement;
}

export interface WaveCirclesOptions {
  /** 走時表。読み込み前は null。読めていなければ円は出ない */
  table: () => TravelTimeTable | null;
  /** 補正済みの現在時刻 (epoch ms) */
  now: () => number;
  /**
   * 表示範囲の倍率（viewBoxの幅 ÷ 基準の幅）。
   * リングは実距離ではなく画面上の大きさを一定に保つので、これで割り戻す。
   */
  scale?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export class WaveCircles {
  private readonly states = new Map<string, WaveCircleState>();
  private frame: number | null = null;
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(
    private readonly layer: SVGGElement,
    private readonly options: WaveCirclesOptions,
  ) {
    this.requestFrame =
      options.requestFrame ?? ((cb) => requestAnimationFrame(() => cb()));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
  }

  /**
   * 進行中のEEWを反映する。
   * 報が更新されるたびに震源要素を差し替える。第1報の値を持ち続けない。
   */
  update(eews: readonly EewEvent[]): void {
    const alive = new Set<string>();

    for (const eew of eews) {
      // 深発地震・PLUM法・取消はここで落ちる
      if (!shouldDrawWaveCircles(eew)) continue;
      const { lat, lon, depthKm } = eew.hypocenter;
      if (lat === null || lon === null || depthKm === null) continue;
      if (eew.originAt === null) continue;

      alive.add(eew.eventId);
      const existing = this.states.get(eew.eventId);
      if (existing) {
        // 要素は作り直さない。アニメーションを切らさず、中心だけが飛ぶ
        existing.lat = lat;
        existing.lon = lon;
        existing.depthKm = depthKm;
        existing.originAtMs = eew.originAt;
      } else {
        this.states.set(eew.eventId, this.createState(eew.eventId, lat, lon, depthKm, eew.originAt));
      }
    }

    // 消えたEEW（取消・時間切れ・深さが150kmを超えた等）の円を外す
    for (const [eventId, state] of this.states) {
      if (alive.has(eventId)) continue;
      state.group.remove();
      this.states.delete(eventId);
    }

    if (this.states.size === 0) this.stop();
    else this.start();
    // 停止中でも1回は描く（テストと、止まった直後の見た目のため）
    this.draw();
  }

  /** 表示範囲が変わったときなど、外から描き直させる */
  redraw(): void {
    this.draw();
  }

  dispose(): void {
    this.stop();
    for (const state of this.states.values()) state.group.remove();
    this.states.clear();
  }

  private createState(
    eventId: string,
    lat: number,
    lon: number,
    depthKm: number,
    originAtMs: number,
  ): WaveCircleState {
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('wave');
    group.setAttribute('data-event', eventId);

    const sPath = document.createElementNS(SVG_NS, 'path');
    sPath.classList.add('wave__s');
    const pPath = document.createElementNS(SVG_NS, 'path');
    pPath.classList.add('wave__p');

    const ringTrack = document.createElementNS(SVG_NS, 'circle');
    ringTrack.classList.add('wave__ring-track');
    const ringArc = document.createElementNS(SVG_NS, 'circle');
    ringArc.classList.add('wave__ring');

    // S波の塗りの上にP波の線が乗るように、S波を先に置く。
    // リングは震央のすぐ周りなので、円より上に出す
    group.append(sPath, pPath, ringTrack, ringArc);
    this.layer.appendChild(group);

    return {
      eventId,
      lat,
      lon,
      depthKm,
      originAtMs,
      group,
      pPath,
      sPath,
      ringTrack,
      ringArc,
    };
  }

  private start(): void {
    if (this.frame !== null) return;
    const tick = (): void => {
      this.frame = null;
      if (this.states.size === 0) return;
      this.draw();
      this.frame = this.requestFrame(tick);
    };
    this.frame = this.requestFrame(tick);
  }

  private stop(): void {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }

  private draw(): void {
    const table = this.options.table();
    const now = this.options.now();

    for (const state of this.states.values()) {
      if (table === null) {
        // 走時表が無ければ半径も待ち時間も出せない。描かない（0kmの円を描かない）
        setPath(state.pPath, '');
        setPath(state.sPath, '');
        hide(state.ringTrack);
        hide(state.ringArc);
        continue;
      }
      const elapsedSec = (now - state.originAtMs) / 1000;
      const radii = waveRadii(table, state.depthKm, elapsedSec);
      setPath(state.pPath, pathFor(state, radii.p));
      setPath(state.sPath, pathFor(state, radii.s));
      this.drawRing(state, table, elapsedSec);
    }
  }

  /**
   * S波が震央直上に出るまでの進み具合を、震央の印を囲むリングで出す。
   *
   * 進み具合が1になった瞬間にS波の予報円が生まれる
   * （同じ走時表・同じ深さを引いている）。出たあとはリングを消す。
   */
  private drawRing(
    state: WaveCircleState,
    table: TravelTimeTable,
    elapsedSec: number,
  ): void {
    const status = surfaceStatus(table, state.depthKm, elapsedSec);
    if (status === null) {
      hide(state.ringTrack);
      hide(state.ringArc);
      return;
    }

    const scale = this.options.scale?.() ?? 1;
    const r = RING_RADIUS * scale;
    const { x, y } = project(state.lon, state.lat);
    const circumference = 2 * Math.PI * r;

    for (const el of [state.ringTrack, state.ringArc]) {
      el.removeAttribute('hidden');
      el.setAttribute('cx', x.toFixed(2));
      el.setAttribute('cy', y.toFixed(2));
      el.setAttribute('r', r.toFixed(2));
    }
    /*
     * 線の太さも座標系の値で渡す（CSSの non-scaling-stroke は使わない）。
     * あれを使うと破線の刻みまで画面座標で解釈され、一周ぶんに指定した長さが
     * 円周と合わなくなって、円の全周に赤い破片が散る。
     */
    state.ringTrack.setAttribute('stroke-width', (RING_TRACK_WIDTH * scale).toFixed(2));
    state.ringArc.setAttribute('stroke-width', (RING_WIDTH * scale).toFixed(2));

    /*
     * 12時の位置から**反時計回り**に満たしていく。
     *
     * SVGの circle は3時から始まって時計回りに進むので、
     *   rotate(-90)          始点を12時に移す
     *   縦軸で鏡映            進む向きを返す（12時の点は鏡映で動かない）
     * の順に掛ける。transform は右から順に適用されるので、鏡映を左に書く。
     */
    const cx = x.toFixed(2);
    const cy = y.toFixed(2);
    state.ringArc.setAttribute(
      'transform',
      `translate(${(x * 2).toFixed(2)} 0) scale(-1 1) rotate(-90 ${cx} ${cy})`,
    );
    state.ringArc.setAttribute('stroke-dasharray', circumference.toFixed(2));
    state.ringArc.setAttribute(
      'stroke-dashoffset',
      (circumference * (1 - status.progress)).toFixed(2),
    );
  }
}

/**
 * 震央距離は地表に沿った距離なので、投影平面上の真円ではなく
 * 球面上の等距離点を投影して多角形にする。
 */
function pathFor(state: WaveCircleState, radiusKm: number | null): string {
  if (radiusKm === null || radiusKm <= 0) return '';
  const points = geodesicCircle(state.lat, state.lon, radiusKm, SEGMENTS);
  if (points.length === 0) return '';

  let d = '';
  for (const [lon, lat] of points) {
    const p = project(lon, lat);
    d += `${d === '' ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return `${d}Z`;
}

function hide(el: SVGElement): void {
  if (!el.hasAttribute('hidden')) el.setAttribute('hidden', '');
}

function setPath(el: SVGPathElement, d: string): void {
  if (d === '') {
    if (!el.hasAttribute('hidden')) el.setAttribute('hidden', '');
    el.removeAttribute('d');
    return;
  }
  el.removeAttribute('hidden');
  el.setAttribute('d', d);
}
