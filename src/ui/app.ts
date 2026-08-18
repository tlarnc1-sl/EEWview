import type { StoreSnapshot } from '../store/store';
import type { SourceId } from '../types';
import type { MergedQuake } from '../store/quake';
import type { ConnectionState } from '../transport/types';
import type { ClockStatus } from '../clock';
import type { TravelTimeTable } from '../lib/travelTime';
import { isPlumMethod } from '../lib/waveCircles';
import { EewPanel, type PendingTsunami } from './eew';
import { MapView } from './map';
import {
  QuakeDetail,
  QuakeList,
  TsunamiPanel,
  hasActiveTsunami,
  heaviestTsunamiGrade,
  isTsunamiChecking,
} from './panels';
import { CompactStatus, SettingsPanel, type ScenarioAction } from './status';
import { ClockPanel } from './clock-view';
import { ObserverEstimate, ObserverSetup } from './observer-view';
import type { ObserverLocation } from '../observer';
import { h, setClass } from './dom';

/**
 * 1画面完結のレイアウト。スクロールさせない。
 *
 *   [地図（EEWを左上に重ね、到達予測を下中央に重ねる）] [津波の列] [一覧 / 詳細 / ステータス]
 *
 * **EEWは地図に重ねる。列にしない。** 列にすると受信のたびに地図の幅が変わり、
 * 再投影で震源の位置が画面上で飛ぶ。左列は上半分しか埋まらず余りも多かった。
 * 真ん中の津波列だけは、区域と高さを縦に並べるので列として開く。
 * 一覧と詳細は右端に固定で位置が動かない。緊急時に画面が組み変わると、
 * 見る側が「どこを見ればいいか」を探し直すことになる。
 *
 * 上に帯は持たない。ステータスと設定は右下に置く。
 */

export interface AppInput {
  snapshot: StoreSnapshot;
  connections: Map<SourceId, ConnectionState>;
  clock: { status: ClockStatus; offsetMs: number | null; samples: number };
  degradedReasons: string[];
}

export interface ObserverHandlers {
  /** 端末の位置情報から設定する */
  useGeolocation: () => void;
  /** 地図をクリックして設定する */
  pickOnMap: () => void;
  /** 設定しないまま閉じる（初回の案内は二度と出さない） */
  dismiss: () => void;
  /** 設定を消す */
  clear: () => void;
}

export interface AppMeta {
  /** 設定に出す接続先 */
  endpoint: string;
  environment: string;
  /** 動作確認のシナリオ。空なら設定にその節を出さない */
  scenarios?: ScenarioAction[];
  /** 投入した分の取り消し */
  onClear?: () => void;
  /** 現在地の設定 */
  observer?: ObserverHandlers;
  /** 地震情報の詳細を出すか（既定は出さない）。設定から切り替える */
  detail?: { enabled: boolean; onChange: (enabled: boolean) => void };
}

export class App {
  readonly el: HTMLElement;
  private readonly eew = new EewPanel();
  private readonly map = new MapView();
  private readonly tsunami = new TsunamiPanel();
  private readonly list = new QuakeList();
  private readonly detail = new QuakeDetail();
  private readonly clock = new ClockPanel();
  private readonly estimate = new ObserverEstimate();
  private readonly setup: ObserverSetup;
  private readonly compact: CompactStatus;
  private readonly settings: SettingsPanel;
  private readonly settingsButton: HTMLButtonElement;
  private readonly tsunamiColumnEl: HTMLElement;
  private selectedKey: string | null = null;
  private lastInput: AppInput | null = null;
  private tsunamiColumnOpen = false;
  private eewColumnOpen = false;
  /** 試験用の電文を投入中なら、そのシナリオ名 */
  private testLabel: string | null = null;

  constructor(meta: AppMeta = { endpoint: '—', environment: '—' }) {
    const sources = [
      { id: 'wolfx' as SourceId, label: 'wolfx' },
      { id: 'p2p' as SourceId, label: 'p2p' },
    ];

    this.compact = new CompactStatus(sources, () => this.toggleSettings());
    this.settings = new SettingsPanel(
      sources,
      meta,
      () => this.toggleSettings(false),
      meta.scenarios ?? [],
      meta.onClear ?? (() => {}),
      meta.observer
        ? {
            set: () => {
              this.toggleSettings(false);
              this.setup.setOpen(true);
            },
            clear: () => meta.observer?.clear(),
          }
        : null,
      meta.detail
        ? {
            enabled: meta.detail.enabled,
            onChange: (on) => {
              this.setDetailVisible(on);
              meta.detail?.onChange(on);
            },
          }
        : null,
    );


    const observer = meta.observer;
    this.setup = new ObserverSetup({
      useGeolocation: () => observer?.useGeolocation(),
      pickOnMap: () => observer?.pickOnMap(),
      dismiss: () => observer?.dismiss(),
    });

    this.settingsButton = h(
      'button',
      { class: 'settings-button', type: 'button', 'aria-label': '設定' },
      '設定',
    );
    this.settingsButton.addEventListener('click', () => this.toggleSettings());

    this.list.select((key) => {
      this.selectedKey = key;
      if (this.lastInput) this.render(this.lastInput);
    });

    // 津波の発表を受けている間だけ開く列
    this.tsunamiColumnEl = h('div', { class: 'main__tsunami' });

    this.el = h(
      'div',
      { class: 'app' },
      h(
        'main',
        { class: 'main' },
        h(
          'div',
          { class: 'main__map' },
          this.map.el,
          // EEWは地図の左上に重ねる。列にしないので、受信しても地図の幅が変わらない
          this.eew.el,
          // 到達予測は地図の下・中央。目を置く場所に大きく出す
          h('div', { class: 'hud' }, this.estimate.el),
        ),
        this.tsunamiColumnEl,
        h(
          'aside',
          { class: 'main__side' },
          this.list.el,
          // 詳細を出していないときは、この位置が時計
          this.clock.el,
          this.detail.el,
          // ステータスと設定は右下。平常時に場所を主張しない
          h('div', { class: 'statusbar' }, this.compact.el, this.settingsButton),
        ),
      ),
      this.settings.el,
      this.setup.el,
    );

    // this.el が組み終わってから（setClass が this.el を触る）
    this.setDetailVisible(meta.detail?.enabled ?? false);

    window.addEventListener('resize', () => this.map.handleResize());
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.toggleSettings(false);
    });
  }

  /** 地震情報の詳細を出すか。既定は出さない（この位置は時計） */
  setDetailVisible(visible: boolean): void {
    this.detail.el.hidden = !visible;
    setClass(this.el, 'app--detail', visible);
  }

  render(input: AppInput, now = Date.now()): void {
    this.lastInput = input;
    const { snapshot } = input;
    // 補正済みの時刻を出す
    this.clock.render(now);
    const alert = snapshot.activeEews.length > 0;

    // 周辺視野で状態が分かるよう、画面の縁の色を変える
    setClass(this.el, 'app--alert', alert);
    setClass(
      this.el,
      'app--warn',
      snapshot.activeEews.some((e) => e.isWarn && !e.isCancel),
    );

    const statusInput = {
      connections: input.connections,
      clock: input.clock,
      parseFailures: snapshot.parseFailures,
      degradedReasons: input.degradedReasons,
    };
    this.compact.render(statusInput, this.testLabel);
    if (this.settings.isOpen) this.settings.render(statusInput);

    /*
     * 津波の列を開くのは、区域のある発表（552）を受けたときだけ。
     * 判定がまだ出ていない段階は左の列の先頭に出す。
     * EEWが消えても判定待ちが残ることがあるので、列はどちらかがあれば開く。
     */
    const showTsunami = hasActiveTsunami(snapshot.tsunami);
    const pending = pendingTsunami(snapshot, showTsunami, now);
    // 津波が発表されている間は、どのEEWのカードにもその旨を載せる
    this.eew.render(
      snapshot.activeEews,
      pending,
      heaviestTsunamiGrade(snapshot.tsunami),
    );
    /*
     * 設定した地点の推定震度と到達カウントダウン。未設定なら何も出ない。
     * 取消の報は渡さない（無かったことになった揺れの到達予測は意味を持たない）。
     * 取消と進行中が混在するときは、進行中のいちばん新しいものを見る。
     */
    const live = snapshot.activeEews.find((e) => !e.isCancel) ?? null;
    this.estimate.render(this.observer, live, this.travelTimeTable, now);
    this.setEewColumn(alert || pending.kind !== 'none');

    const selected = this.resolveSelected(snapshot.quakes);
    this.list.setSelected(selected?.key ?? null);
    this.list.render(snapshot.quakes);
    this.detail.render(selected);

    // 進行中のEEWの予報円。描くかどうかの判定は lib/waveCircles.ts に閉じている
    this.map.setWaves(snapshot.activeEews);

    // EEW受信中は震源が主役。平常時は選択中の地震を見せる
    this.map.render({
      hypocenter: snapshot.activeEew?.hypocenter ?? selected?.hypocenter ?? null,
      points: alert ? [] : (selected?.points ?? []),
      alert,
      // PLUM法は震源を決める手法ではないので、×印ではなく円を出す
      plum: snapshot.activeEew !== null && isPlumMethod(snapshot.activeEew),
      // 選択中の地震（起動直後は最新）の主な揺れが入るところまで寄せる
      zoom: alert || selected !== null,
    });

    if (showTsunami) this.tsunami.render(snapshot.tsunami, false);
    this.setTsunamiColumn(showTsunami);
  }

  /** 走時表。予報円と到達予測の両方で使う */
  private travelTimeTable: TravelTimeTable | null = null;

  setTravelTimeTable(table: TravelTimeTable | null): void {
    this.travelTimeTable = table;
    this.map.setTravelTimeTable(table);
    if (this.lastInput) this.render(this.lastInput);
  }

  /** 補正済みの現在時刻。予報円の経過秒数に使う */
  setClock(now: () => number): void {
    this.map.setClock(now);
    // カウントダウンは0.1秒まで出すので、1秒ごとの再描画では足りない。
    // 時計を渡すと自分でフレームを回す
    this.estimate.setClock(now);
  }

  /** 現在地。未設定なら null */
  private observer: ObserverLocation | null = null;

  setObserver(observer: ObserverLocation | null): void {
    this.observer = observer;
    this.settings.setObserver(observer);
    if (this.lastInput) this.render(this.lastInput);
  }

  /** 初回の案内を出す */
  openObserverSetup(open: boolean): void {
    this.setup.setOpen(open);
  }

  setObserverSetupStatus(text: string): void {
    this.setup.setStatus(text);
  }

  /** 地図クリックで地点を選ぶモード */
  setPickingLocation(picking: boolean, onPick: (lat: number, lon: number) => void): void {
    this.map.setPicking(picking, onPick);
    setClass(this.el, 'app--picking', picking);
  }

  /**
   * 試験用の電文を投入中であることを画面に出す。
   * 試したデータを本物と取り違えたら、この計器は嘘をつくことになる。
   */
  setTestLabel(label: string | null): void {
    if (label === this.testLabel) return;
    this.testLabel = label;
    setClass(this.el, 'app--test', label !== null);
    if (this.lastInput) this.render(this.lastInput);
  }

  /**
   * EEWの枠を出す・引っ込める。
   *
   * 地図に重ねるだけなので、**地図の大きさは変わらない**（列にしていた頃は
   * 開くたびに地図が再投影され、震源の位置が画面上で飛んでいた）。
   */
  private setEewColumn(open: boolean): void {
    if (open === this.eewColumnOpen) return;
    this.eewColumnOpen = open;
    setClass(this.el, 'app--eew', open);
  }

  /**
   * 津波の欄は、地震情報の隣・同じ高さの列として現れる。
   * 出す必要が無くなったら列ごと消す（右側に常駐させない）。
   */
  private setTsunamiColumn(open: boolean): void {
    if (open === this.tsunamiColumnOpen) return;
    this.tsunamiColumnOpen = open;
    if (open) {
      this.tsunamiColumnEl.appendChild(this.tsunami.el);
    } else {
      this.tsunami.el.remove();
    }
    setClass(this.el, 'app--tsunami', open);
    this.map.handleResize();
  }

  private toggleSettings(force?: boolean): void {
    const next = force ?? !this.settings.isOpen;
    this.settings.setOpen(next);
    setClass(this.el, 'app--settings', next);
    setClass(this.settingsButton, 'settings-button--open', next);
    if (next && this.lastInput) this.render(this.lastInput);
  }

  /** 直前に見ていた最新の地震。新しいものが来たかの判定に使う */
  private newestKey: string | null = null;

  /**
   * 出す地震を決める。
   *
   * **新しい地震が来たら、そこへ移る。** 古いものを見ている最中でも、
   * 新着があればそちらが主役になる（見たいのは今起きていることなので）。
   * 手で選んだものは、次の新着まで保たれる。
   */
  private resolveSelected(quakes: MergedQuake[]): MergedQuake | null {
    const newest = quakes[0] ?? null;
    if (newest !== null && newest.key !== this.newestKey) {
      this.newestKey = newest.key;
      // 新着が来たので、手で選んでいた分は解除する
      this.selectedKey = null;
    }

    if (this.selectedKey !== null) {
      const hit = quakes.find((q) => q.key === this.selectedKey);
      if (hit) return hit;
    }
    return newest;
  }
}

/**
 * 津波の判定がまだ出ていないか。
 *
 * 確定情報（区域のある発表）が出ていれば、そちらが列に出るのでここでは出さない。
 * 取消だけのEEWでは出さない（地震そのものが無かったのだから判定も無い）。
 *
 * 調査中は最新の地震だけを見る。気象庁が Checking と言っている限り出し続け、
 * 経過時間も添える。時間で勝手に消すと、決着したのか続報が来ていないのかが
 * 区別できなくなる。
 */
function pendingTsunami(
  snapshot: StoreSnapshot,
  hasConfirmed: boolean,
  now: number,
): PendingTsunami {
  if (hasConfirmed) return { kind: 'none' };

  const latest = snapshot.quakes[0];
  if (isTsunamiChecking(latest)) {
    const since = latest?.occurredAt ?? latest?.updatedAt ?? null;
    return { kind: 'checking', sinceMs: since === null ? null : now - since };
  }

  const live = snapshot.activeEews.some((e) => !e.isCancel);
  return live ? { kind: 'eew' } : { kind: 'none' };
}
