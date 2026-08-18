import type {
  EewEvent,
  NormalizedEvent,
  ParseFailure,
  SourceId,
  TsunamiEvent,
} from '../types';
import { Emitter } from '../util/emitter';
import { applyReport, createMerged, type MergedQuake } from './quake';

/**
 * 正規化イベントの受け皿。重複排除と順序逆転の始末をここで完結させる。
 * UIはこのスナップショットだけを見る。
 */

/**
 * EEWを「進行中」として扱う時間。
 *
 * 数え始めは**最後に受けた報**。第1報からではない。
 * 連続報が長引いても途中で消えないようにするため。
 *
 * 最終報（isFinal）を受けていれば、続報はもう来ないので短くてよい。
 * 来ていなければ、まだ続く可能性があるので長めに待つ。
 *
 * 地震情報（551）の到着は合図にしない。震度速報は揺れの最中に届くので、
 * それで引っ込めると揺れが続いている最中に画面が平常時に戻る。
 */
export const EEW_WINDOW_AFTER_FINAL_MS = 2 * 60 * 1000;
export const EEW_WINDOW_AFTER_REPORT_MS = 3 * 60 * 1000;

export interface StoreSnapshot {
  /** 進行中のEEW。新しい順。平常時は空 */
  activeEews: EewEvent[];
  /** そのうち最新の1件。無ければ null */
  activeEew: EewEvent | null;
  /** 直近のEEW（履歴表示用。進行中とは限らない） */
  recentEews: EewEvent[];
  quakes: MergedQuake[];
  tsunami: TsunamiEvent | null;
  /** パースできなかった数。0でなければ degraded */
  parseFailures: number;
  lastParseFailure: ParseFailure | null;
  /** 破棄したイベント数（重複・順序逆転）。診断用 */
  discarded: number;
}

export interface StoreOptions {
  /** 一覧に残す地震の数 */
  maxQuakes?: number;
  maxEews?: number;
  now?: () => number;
}

export class EventStore {
  private readonly changes = new Emitter<StoreSnapshot>();
  private readonly eews = new Map<string, EewEvent>();
  private readonly quakes = new Map<string, MergedQuake>();
  private readonly seenIds = new Set<string>();
  private tsunami: TsunamiEvent | null = null;
  private parseFailures = 0;
  private lastParseFailure: ParseFailure | null = null;
  private discarded = 0;
  private readonly maxQuakes: number;
  private readonly maxEews: number;
  private readonly now: () => number;

  constructor(options: StoreOptions = {}) {
    this.maxQuakes = options.maxQuakes ?? 50;
    this.maxEews = options.maxEews ?? 20;
    this.now = options.now ?? (() => Date.now());
  }

  onChange(fn: (s: StoreSnapshot) => void): () => void {
    return this.changes.subscribe(fn);
  }

  /**
   * 正規化イベントを1件取り込む。
   * @returns 状態が変わったら true
   */
  ingest(event: NormalizedEvent | ParseFailure | null): boolean {
    if (event === null) return false;

    let changed = false;
    switch (event.kind) {
      case 'parse-failure':
        this.parseFailures += 1;
        this.lastParseFailure = event;
        changed = true;
        break;
      case 'eew':
        changed = this.ingestEew(event);
        break;
      case 'quake':
        changed = this.ingestQuake(event);
        break;
      case 'tsunami':
        changed = this.ingestTsunami(event);
        break;
    }

    if (changed) this.changes.emit(this.snapshot());
    return changed;
  }

  /**
   * EEWの重複排除。
   * - eventId をキー、serial で更新
   * - serial が保持中より小さい報は破棄（順序逆転はネットワークで普通に起きる）
   * - 同じ serial が別ソースから来たら先着を採用
   * - キャンセル報の後に来た報は破棄
   */
  private ingestEew(event: EewEvent): boolean {
    const existing = this.eews.get(event.eventId);
    if (existing) {
      if (existing.isCancel) {
        this.discarded += 1;
        return false;
      }
      if (event.serial <= existing.serial) {
        this.discarded += 1;
        return false;
      }
    }
    this.eews.set(event.eventId, event);
    this.trimEews();
    return true;
  }

  private ingestQuake(event: NormalizedEvent & { kind: 'quake' }): boolean {
    // 同一レコードが複数回配信されうる
    if (this.seenIds.has(event.id)) {
      this.discarded += 1;
      return false;
    }
    this.seenIds.add(event.id);

    const existing = this.quakes.get(event.quakeKey);
    this.quakes.set(
      event.quakeKey,
      existing ? applyReport(existing, event) : createMerged(event),
    );
    this.trimQuakes();
    return true;
  }

  private ingestTsunami(event: TsunamiEvent): boolean {
    if (this.seenIds.has(event.id)) {
      this.discarded += 1;
      return false;
    }
    this.seenIds.add(event.id);
    // 発表時刻が古い報で新しい状態を上書きしない
    if (
      this.tsunami &&
      this.tsunami.issuedAt !== null &&
      event.issuedAt !== null &&
      event.issuedAt < this.tsunami.issuedAt
    ) {
      this.discarded += 1;
      return false;
    }
    this.tsunami = event;
    return true;
  }

  /**
   * 進行中のEEW。新しい順。
   *
   * 大地震の直後は余震で連続するので、1件に絞らず全部返す。
   * 接続直後に投げ込まれた過去の報（historical）は決してここに出さない。
   * 数時間前の報で画面が緊急表示になる事故を防ぐ。
   */
  getActiveEews(now = this.now()): EewEvent[] {
    const active: EewEvent[] = [];
    for (const eew of this.eews.values()) {
      if (eew.historical) continue;
      if (eew.isTraining) continue;
      // 保持しているのは最新報なので、この時刻が「最後に受けた報」の時刻
      const at = eew.announcedAt ?? eew.receivedAt;
      const window = eew.isFinal
        ? EEW_WINDOW_AFTER_FINAL_MS
        : EEW_WINDOW_AFTER_REPORT_MS;
      if (now - at > window) continue;
      active.push(eew);
    }
    return active.sort(
      (a, b) =>
        (b.announcedAt ?? b.receivedAt) - (a.announcedAt ?? a.receivedAt),
    );
  }

  /** 進行中のうち最新の1件 */
  getActiveEew(now = this.now()): EewEvent | null {
    return this.getActiveEews(now)[0] ?? null;
  }

  snapshot(now = this.now()): StoreSnapshot {
    const activeEews = this.getActiveEews(now);
    return {
      activeEews,
      activeEew: activeEews[0] ?? null,
      recentEews: [...this.eews.values()].sort(
        (a, b) =>
          (b.announcedAt ?? b.receivedAt) - (a.announcedAt ?? a.receivedAt),
      ),
      quakes: [...this.quakes.values()].sort(
        (a, b) => (b.occurredAt ?? b.updatedAt) - (a.occurredAt ?? a.updatedAt),
      ),
      tsunami: this.tsunami,
      parseFailures: this.parseFailures,
      lastParseFailure: this.lastParseFailure,
      discarded: this.discarded,
    };
  }

  /** 時間経過だけで進行中EEWが切れることがあるので、UIから定期的に呼ぶ */
  refresh(): void {
    this.changes.emit(this.snapshot());
  }

  /**
   * 指定したIDのイベントだけを取り除く。
   *
   * 動作確認で投入したものを片付けるためのもの。
   * 全消しにすると実際に受信した内容まで巻き添えになるので、
   * 消す対象を呼び出し側が名指しする形にしてある。
   */
  forget(ids: Iterable<string>): boolean {
    const set = new Set(ids);
    if (set.size === 0) return false;
    let changed = false;

    for (const [eventId] of this.eews) {
      if (set.has(eventId)) {
        this.eews.delete(eventId);
        changed = true;
      }
    }
    for (const [key, quake] of this.quakes) {
      if (quake.reportIds.some((id) => set.has(id))) {
        this.quakes.delete(key);
        changed = true;
      }
    }
    if (this.tsunami && set.has(this.tsunami.id)) {
      this.tsunami = null;
      changed = true;
    }
    // 同じシナリオをもう一度流せるよう、重複排除の記録からも外す
    for (const id of set) this.seenIds.delete(id);

    if (changed) this.changes.emit(this.snapshot());
    return changed;
  }

  reset(): void {
    this.eews.clear();
    this.quakes.clear();
    this.seenIds.clear();
    this.tsunami = null;
    this.parseFailures = 0;
    this.lastParseFailure = null;
    this.discarded = 0;
    this.changes.emit(this.snapshot());
  }

  private trimQuakes(): void {
    if (this.quakes.size <= this.maxQuakes) return;
    const sorted = [...this.quakes.entries()].sort(
      (a, b) =>
        (b[1].occurredAt ?? b[1].updatedAt) - (a[1].occurredAt ?? a[1].updatedAt),
    );
    for (const [key] of sorted.slice(this.maxQuakes)) this.quakes.delete(key);
  }

  private trimEews(): void {
    if (this.eews.size <= this.maxEews) return;
    const sorted = [...this.eews.entries()].sort(
      (a, b) =>
        (b[1].announcedAt ?? b[1].receivedAt) -
        (a[1].announcedAt ?? a[1].receivedAt),
    );
    for (const [key] of sorted.slice(this.maxEews)) this.eews.delete(key);
  }
}

/** ソース別の受信状況。フェイルサイレント防止の材料 */
export interface SourceHealth {
  source: SourceId;
  lastEventAt: number | null;
}
