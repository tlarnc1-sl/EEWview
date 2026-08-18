import type { EewEvent, Hypocenter, QuakePoint } from '../types';
import type { TravelTimeTable } from '../lib/travelTime';
import { WaveCircles } from './waves';
import {
  intensityColor,
  intensityParts,
  intensityTextColor,
  type IntensityParts,
} from '../adapters/intensity';
import {
  CANVAS,
  FULL_VIEWPORT,
  centerViewport,
  clampToView,
  fitViewport,
  inView,
  lookupStation,
  prefecturePaths,
  project,
  unproject,
  type Point,
  type Viewport,
} from './geo';

/**
 * 日本地図。SVG（地形と震源）とCanvas（観測点が多いとき）の2枚重ね。
 *
 * 通常運用の震度分布はせいぜい数十〜数百点なのでDOMで足りる。
 * 巨大地震では2829点まで跳ねるので、そのときだけCanvasに切り替える。
 * 最初からCanvas前提にはしない（過剰設計になる）。
 *
 * 拡大しても点や印の見かけの大きさが変わらないよう、大きさは
 * 表示範囲の幅に比例させている（viewBoxを縮めると図形は拡大されるため）。
 */

/** これを超えたらDOMをやめてCanvasで描く */
const CANVAS_THRESHOLD = 300;

/** EEW受信中に震源のまわりを切り出す幅（1000 のうち） */
const EEW_VIEW_SIZE = 340;

/** 表示範囲がこれより狭くなったら、点に震度の数字を出す */
const LABEL_VIEW_SIZE = 430;

/**
 * 「主な揺れ」とみなす震度の幅。
 * 最大震度からこの段数までを、拡大したときに必ず入れる。
 * 全点を入れると、遠くの震度1に引っぱられて結局全国が映る。
 */
const MAIN_SHAKING_STEPS = 2;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface MapState {
  hypocenter: Hypocenter | null;
  points: QuakePoint[];
  /** EEW受信中は震源マーカーを濃くする */
  alert: boolean;
  /**
   * PLUM法の報か。
   * PLUM法は震源を決める手法ではないので、震央の×印を出さない。
   * 位置が確からしくないことを示す円にする。
   */
  plum?: boolean;
  /** 主な揺れが入る範囲まで寄せる。false なら全域 */
  zoom: boolean;
}

interface PlottedPoint {
  x: number;
  y: number;
  color: string;
  textColor: string;
  label: IntensityParts;
  /** 震度階級の値。描画順と「主な揺れ」の判定に使う */
  value: number;
  main: boolean;
}

export class MapView {
  readonly el: HTMLElement;
  readonly resetButton: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly pointLayer: SVGGElement;
  private readonly waveLayer: SVGGElement;
  private readonly markerLayer: SVGGElement;
  private readonly waves: WaveCircles;
  private travelTimeTable: TravelTimeTable | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly outOfView: HTMLElement;
  private lastSignature = '';
  private lastState: MapState | null = null;
  private plotted: PlottedPoint[] = [];
  private viewport: Viewport = FULL_VIEWPORT;
  /** 全域に戻す指示。ユーザーが押したら、次の地震を選ぶまで寄せない */
  private forceFull = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'map';

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', viewBoxOf(FULL_VIEWPORT));
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.classList.add('map__svg');

    const land = document.createElementNS(SVG_NS, 'g');
    land.classList.add('map__land');
    for (const pref of prefecturePaths()) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pref.d);
      path.setAttribute('data-pref', pref.name);
      land.appendChild(path);
    }
    this.svg.appendChild(land);

    this.pointLayer = document.createElementNS(SVG_NS, 'g');
    this.pointLayer.classList.add('map__points');
    this.svg.appendChild(this.pointLayer);

    // 予報円は観測点の上・震源マーカーの下
    this.waveLayer = document.createElementNS(SVG_NS, 'g');
    this.waveLayer.classList.add('map__waves');
    this.svg.appendChild(this.waveLayer);

    this.markerLayer = document.createElementNS(SVG_NS, 'g');
    this.markerLayer.classList.add('map__markers');
    this.svg.appendChild(this.markerLayer);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map__canvas';
    this.canvas.hidden = true;

    this.outOfView = document.createElement('div');
    this.outOfView.className = 'map__outside';
    this.outOfView.hidden = true;

    // 全域と、揺れの範囲との行き来。押しっぱなしで戻れなくならないようトグルにする
    this.resetButton = document.createElement('button');
    this.resetButton.className = 'map__reset';
    this.resetButton.type = 'button';
    this.resetButton.textContent = '全域';
    this.resetButton.hidden = true;
    this.resetButton.addEventListener('click', () => {
      this.forceFull = !this.forceFull;
      if (!this.lastState) return;
      this.applyViewport(this.viewportFor(this.lastState));
      this.drawContents();
    });

    this.el.append(this.svg, this.canvas, this.outOfView, this.resetButton);

    this.waves = new WaveCircles(this.waveLayer, {
      table: () => this.travelTimeTable,
      now: () => this.nowMs(),
      // 震央のリングは×印と同じく、拡大しても見かけの大きさを変えない
      scale: () => this.zoomRatio,
    });
  }

  /** 補正済みの現在時刻。main.ts から差し替える */
  private nowMs: () => number = () => Date.now();

  setClock(now: () => number): void {
    this.nowMs = now;
  }

  /** 走時表。読み込めるまで予報円は出ない */
  setTravelTimeTable(table: TravelTimeTable | null): void {
    this.travelTimeTable = table;
    this.waves.redraw();
  }

  /** 進行中のEEWを予報円に反映する */
  setWaves(eews: readonly EewEvent[]): void {
    this.waves.update(eews);
  }

  render(state: MapState): void {
    // 何も変わっていないなら触らない。アイドル時のコストをゼロに近づける
    const signature = signatureOf(state);
    if (signature === this.lastSignature) return;
    // 見ている対象が変わったら、全域固定は解除する
    this.forceFull = false;
    this.lastSignature = signature;
    this.lastState = state;

    this.collectPoints(state.points);
    this.applyViewport(this.viewportFor(state));
    this.drawContents();
  }

  /**
   * 地図クリックで地点を選ぶモード。
   * SVGは viewBox で拡大しているので、クリック位置は SVG の座標系に直してから戻す。
   */
  setPicking(picking: boolean, onPick: (lat: number, lon: number) => void): void {
    this.el.classList.toggle('map--picking', picking);
    if (this.pickHandler) {
      this.svg.removeEventListener('click', this.pickHandler);
      this.pickHandler = null;
    }
    if (!picking) return;

    this.pickHandler = (ev: MouseEvent) => {
      const rect = this.svg.getBoundingClientRect();
      // preserveAspectRatio="meet" と同じ収め方を戻す
      const scale = Math.min(rect.width / this.viewport.w, rect.height / this.viewport.h);
      const offsetX = (rect.width - this.viewport.w * scale) / 2;
      const offsetY = (rect.height - this.viewport.h * scale) / 2;
      const x = this.viewport.x + (ev.clientX - rect.left - offsetX) / scale;
      const y = this.viewport.y + (ev.clientY - rect.top - offsetY) / scale;
      const { lat, lon } = unproject(x, y);
      onPick(lat, lon);
    };
    this.svg.addEventListener('click', this.pickHandler);
  }

  private pickHandler: ((ev: MouseEvent) => void) | null = null;

  /** 画面サイズが変わったらCanvasを描き直す（SVGは自動で追従する） */
  handleResize(): void {
    if (!this.canvas.hidden) this.drawCanvas();
  }

  private drawContents(): void {
    this.renderPointLayer();
    this.renderHypocenter(
      this.lastState?.hypocenter ?? null,
      this.lastState?.alert ?? false,
      this.lastState?.plum ?? false,
    );
  }

  /** いま表示する範囲。全域固定が押されていればそちらを優先する */
  private viewportFor(state: MapState): Viewport {
    return this.forceFull ? FULL_VIEWPORT : this.zoomedViewport(state);
  }

  /**
   * この地震で見るべき範囲。
   *
   * 主な揺れ（最大震度から数段以内）の観測点と震源が入るところまで寄せる。
   * 全点を入れると遠方の震度1に引っぱられて全国が映り、拡大の意味がなくなる。
   */
  private zoomedViewport(state: MapState): Viewport {
    if (!state.zoom) return FULL_VIEWPORT;

    const epicenter = this.epicenterPoint(state.hypocenter);

    if (state.alert) {
      // EEW受信中は震度の情報がまだ無い。震源のまわりを一定の幅で切り出す
      return epicenter ? centerViewport(epicenter, EEW_VIEW_SIZE) : FULL_VIEWPORT;
    }

    const main = this.plotted.filter((p) => p.main);
    // 必ず複製する。this.plotted をそのまま使うと、震源を push したときに
    // 描画対象の観測点リストへ座標だけの偽の点が混ざる
    const targets: Point[] = main.length > 0 ? [...main] : [...this.plotted];
    if (epicenter) targets.push(epicenter);
    return fitViewport(targets);
  }

  private epicenterPoint(h: Hypocenter | null): Point | null {
    if (!h || h.lat === null || h.lon === null) return null;
    // 範囲外（遠地地震）の震源に寄せると日本が映らなくなる
    if (!inView(h.lon, h.lat)) return null;
    return project(h.lon, h.lat);
  }

  private applyViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.svg.setAttribute('viewBox', viewBoxOf(viewport));
    this.el.classList.toggle('map--zoomed', viewport.w < CANVAS.width);
    this.updateResetButton();
    // 震央のリングは倍率で大きさが決まる。範囲が変わったら引き直す
    this.waves.redraw();
  }

  /**
   * 寄せられる対象があるときだけボタンを出し、いまの状態と逆の行き先を書く。
   * 「全域」で戻したあと、同じ地震にもう一度寄せられるようにするため。
   */
  private updateResetButton(): void {
    const zoomable =
      this.lastState !== null && this.zoomedViewport(this.lastState).w < CANVAS.width;
    this.resetButton.hidden = !zoomable;
    this.resetButton.textContent = this.forceFull ? '揺れの範囲' : '全域';
  }

  /** 表示範囲に対する見かけの大きさを一定に保つための倍率 */
  private get zoomRatio(): number {
    return this.viewport.w / CANVAS.width;
  }

  /** 十分に寄っていれば、点の中に震度の数字を出す */
  private get showLabels(): boolean {
    return this.viewport.w <= LABEL_VIEW_SIZE;
  }

  private pointRadius(): number {
    // 数字を入れるときは丸を大きくする（読めない丸に文字を詰めない）
    return (this.showLabels ? 11 : 5) * this.zoomRatio;
  }

  /**
   * 打てる点だけを集める。
   *
   * 打てないのは、区域別（震度速報。座標を持たない）、観測点一覧に無い名前、
   * 表示範囲外の3つ。いずれも詳細の一覧には震度つきで出ているので、
   * 地図側では黙って落とす。
   */
  private collectPoints(points: QuakePoint[]): void {
    const plotted: PlottedPoint[] = [];
    let maxValue = -1;
    for (const p of points) {
      // 区域別（震度速報）は座標を持たない。代表点をでっち上げて描かない
      const coord = p.isArea ? null : lookupStation(p.addr);
      if (!coord) continue;
      const [lon, lat] = coord;
      if (!inView(lon, lat)) continue;
      const { x, y } = project(lon, lat);
      const value = p.intensity?.value ?? -1;
      maxValue = Math.max(maxValue, value);
      plotted.push({
        x,
        y,
        color: intensityColor(p.intensity),
        textColor: intensityTextColor(p.intensity),
        label: intensityParts(p.intensity),
        value,
        main: false,
      });
    }

    // 震度階級はおおむね5刻み（45と46だけ隣接）。段数で数える
    const threshold = maxValue - MAIN_SHAKING_STEPS * 5;
    for (const p of plotted) p.main = p.value >= threshold;

    this.plotted = plotted;
  }

  private renderPointLayer(): void {
    if (this.plotted.length > CANVAS_THRESHOLD) {
      this.pointLayer.replaceChildren();
      this.drawCanvas();
      return;
    }

    this.canvas.hidden = true;
    const r = this.pointRadius();
    const fontSize = r * 1.25;
    // 弱い震度から描いて、強い震度を上に出す
    const ordered = [...this.plotted].sort((a, b) => a.value - b.value);
    const frag = document.createDocumentFragment();
    for (const p of ordered) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', r.toFixed(2));
      c.setAttribute('fill', p.color);
      frag.appendChild(c);

      if (!this.showLabels || p.label.num === '—') continue;
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', p.x.toFixed(1));
      t.setAttribute('y', p.y.toFixed(1));
      t.setAttribute('fill', p.textColor);
      t.setAttribute('font-size', fontSize.toFixed(2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.classList.add('map__label');

      const num = document.createElementNS(SVG_NS, 'tspan');
      num.textContent = p.label.num;
      t.appendChild(num);
      if (p.label.mod !== null) {
        // 符号は小さく、少し上に、斜体で
        const mod = document.createElementNS(SVG_NS, 'tspan');
        mod.setAttribute('dy', (-fontSize * 0.3).toFixed(2));
        mod.setAttribute('font-size', (fontSize * 0.65).toFixed(2));
        mod.textContent = p.label.mod;
        t.appendChild(mod);
      }
      frag.appendChild(t);
    }
    this.pointLayer.replaceChildren(frag);
  }

  private drawCanvas(): void {
    const rect = this.el.getBoundingClientRect();
    const width = rect.width || CANVAS.width;
    const height = rect.height || CANVAS.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.hidden = false;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    // SVGの preserveAspectRatio="xMidYMid meet" と同じ収め方をなぞる。
    // ここがずれると観測点だけが地形からずれて、静かに嘘をつくことになる。
    const scale = Math.min(width / this.viewport.w, height / this.viewport.h);
    const offsetX = (width - this.viewport.w * scale) / 2;
    const offsetY = (height - this.viewport.h * scale) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(
      scale * dpr,
      0,
      0,
      scale * dpr,
      (offsetX - this.viewport.x * scale) * dpr,
      (offsetY - this.viewport.y * scale) * dpr,
    );

    const r = this.pointRadius();
    const fontSize = r * 1.25;
    const labels = this.showLabels;
    // SVG側（.map__label）と同じ組み方。数字も斜体
    const numFont = `italic 700 ${fontSize.toFixed(2)}px Montserrat, sans-serif`;
    const modFont = `italic 700 ${(fontSize * 0.65).toFixed(2)}px Montserrat, sans-serif`;
    if (labels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }

    const ordered = [...this.plotted].sort((a, b) => a.value - b.value);
    for (const p of ordered) {
      // 表示範囲の外は描かない。2829点でも見えている分だけで済む
      if (!this.inViewport(p, r)) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      if (labels && p.label.num !== '—') {
        ctx.fillStyle = p.textColor;
        if (p.label.mod === null) {
          ctx.font = numFont;
          ctx.fillText(p.label.num, p.x, p.y);
        } else {
          // SVG側と同じ組み方。数字を少し左に寄せ、符号を小さく上に置く
          ctx.font = numFont;
          ctx.fillText(p.label.num, p.x - fontSize * 0.18, p.y);
          ctx.font = modFont;
          ctx.fillText(p.label.mod, p.x + fontSize * 0.3, p.y - fontSize * 0.28);
        }
      }
    }
  }

  private inViewport(p: Point, margin: number): boolean {
    const v = this.viewport;
    return (
      p.x >= v.x - margin &&
      p.x <= v.x + v.w + margin &&
      p.y >= v.y - margin &&
      p.y <= v.y + v.h + margin
    );
  }

  private renderHypocenter(
    h: Hypocenter | null,
    alert: boolean,
    plum: boolean,
  ): void {
    this.markerLayer.replaceChildren();
    this.outOfView.hidden = true;
    if (!h || h.lat === null || h.lon === null) return;

    const outside = !inView(h.lon, h.lat);
    const { x, y } = outside ? clampToView(h.lon, h.lat) : project(h.lon, h.lat);

    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('map__epicenter');
    // 平常時は不透明度を落とし、EEW受信中は濃くする
    g.classList.toggle('map__epicenter--alert', alert);
    g.classList.toggle('map__epicenter--outside', outside);

    if (plum) {
      /*
       * PLUM法は震源を決める手法ではない。観測された揺れから周辺の揺れを
       * 予測するものなので、震央を指す×印は出さない。
       * 「このあたりで揺れている」ことだけを示す、ぼんやり光る円にする。
       */
      g.classList.add('map__epicenter--plum');
      // 円は1本だけ。重ねると同心円に見えて「複数の何か」と読めてしまう。
      // 光り方は CSS の drop-shadow（にじみ）で作る
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', x.toFixed(2));
      c.setAttribute('cy', y.toFixed(2));
      c.setAttribute('r', (13 * this.zoomRatio).toFixed(2));
      c.classList.add('map__core');
      g.appendChild(c);
    } else {
      // 気象庁と同じ×印。拡大しても見かけの大きさは変えない
      const arm = (alert ? 11 : 9) * this.zoomRatio;
      for (const [sx, sy] of [
        [1, 1],
        [1, -1],
      ] as const) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', (x - arm * sx).toFixed(2));
        line.setAttribute('y1', (y - arm * sy).toFixed(2));
        line.setAttribute('x2', (x + arm * sx).toFixed(2));
        line.setAttribute('y2', (y + arm * sy).toFixed(2));
        g.appendChild(line);
      }
    }
    this.markerLayer.appendChild(g);

    if (outside) {
      // 縁に貼り付けた位置は方角でしかない。位置として読ませない
      this.outOfView.textContent = `震源は地図の範囲外（${h.lat.toFixed(1)}, ${h.lon.toFixed(1)}）`;
      this.outOfView.hidden = false;
    }
  }
}

function viewBoxOf(v: Viewport): string {
  return `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`;
}

function signatureOf(state: MapState): string {
  const h = state.hypocenter;
  return [
    h?.lat ?? '',
    h?.lon ?? '',
    state.alert ? 'a' : '',
    state.plum ? 'u' : '',
    state.zoom ? 'z' : '',
    pointsFingerprint(state.points),
  ].join('|');
}

/**
 * 観測点の並びが変わったかの指紋。
 *
 * **件数と先頭の1点だけでは足りない。** 続報で観測点の数が変わらないまま
 * 震度だけが訂正されることがあり、そのとき地図が古い色のまま残る。
 * 黙って古い値を見せるのがいちばん悪い壊れ方なので、全点を見る。
 * 巨大地震でも2829点、1秒に1回の文字列連結で足りる。
 */
function pointsFingerprint(points: readonly QuakePoint[]): string {
  let out = String(points.length);
  for (const p of points) out += `,${p.addr}:${p.intensity?.value ?? ''}`;
  return out;
}
