/**
 * 観測者（このアプリを見ている人）の現在地。
 *
 * 次フェーズの主要動到達予測で「自分の場所にいつ来るか」を出すために要る。
 * 計算そのものは今回作らない。ここは**保持と取り出しだけ**。
 *
 * 未設定なら null を返す。呼び出し側は null のとき該当UIを出さないこと。
 * 「現在地不明のまま0秒として計算する」ような扱いをしてはいけない。
 */

const KEY = 'eew-view.observer';

export interface ObserverLocation {
  lat: number;
  lon: number;
  /** 表示名（任意） */
  label: string | null;
  /** 設定した時刻 */
  savedAt: number;
  /**
   * その地点の表層30m平均S波速度 (m/s)。設定時に J-SHIS から1回引いて保存する。
   * 引けなければ null。null のときは震度を計算しない（増幅なしで代用しない）。
   */
  avs30: number | null;
  /** 微地形区分名。値がおかしいときの手がかり */
  jname: string | null;
}

export function loadObserver(storage: Storage = localStorage): ObserverLocation | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ObserverLocation>;
    if (
      typeof parsed.lat !== 'number' ||
      typeof parsed.lon !== 'number' ||
      !Number.isFinite(parsed.lat) ||
      !Number.isFinite(parsed.lon)
    ) {
      return null;
    }
    return {
      lat: parsed.lat,
      lon: parsed.lon,
      label: typeof parsed.label === 'string' ? parsed.label : null,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      avs30:
        typeof parsed.avs30 === 'number' && Number.isFinite(parsed.avs30)
          ? parsed.avs30
          : null,
      jname: typeof parsed.jname === 'string' ? parsed.jname : null,
    };
  } catch {
    return null;
  }
}

export function saveObserver(
  location: Omit<ObserverLocation, 'savedAt'>,
  storage: Storage = localStorage,
): ObserverLocation | null {
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return null;
  const value: ObserverLocation = { ...location, savedAt: Date.now() };
  try {
    storage.setItem(KEY, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}

export function clearObserver(storage: Storage = localStorage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // 消せなくても致命的ではない
  }
}

/**
 * 次フェーズの入り口。
 *
 * 到達予測を作るときは、
 *   - 震源（lat/lon/depth）と発震時刻が揃っていること
 *   - EewEvent.epicenterReliable が true であること
 *   - 走時表（tjma2001）を読み込んで P/S の走時を引くこと
 * が前提になる。ここに置くのは合図だけで、計算は今回書かない。
 */
export const TRAVEL_TIME_TABLE_PATH = 'assets/tjma2001.bin';
