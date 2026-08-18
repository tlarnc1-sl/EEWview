import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventStore } from '../src/store/store';
import { parseP2pMessage } from '../src/adapters/p2p';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { EewEvent, QuakeInfoEvent } from '../src/types';

const quake = JSON.parse(
  readFileSync(new URL('../fixtures/quake.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];
const history = JSON.parse(
  readFileSync(new URL('../fixtures/history.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

const NOW = Date.parse('2026-08-16T10:00:00Z');
const p2p = (raw: unknown, now = NOW) =>
  parseP2pMessage(raw, { receivedAt: now, now }) as QuakeInfoEvent;

function feed(store: EventStore, raws: unknown[], now = NOW): void {
  for (const r of raws) store.ingest(parseP2pMessage(r, { receivedAt: now, now }));
}

describe('地震情報のマージ', () => {
  it('history.json 50件を取り込むと地震ごとにまとまる', () => {
    const store = new EventStore({ now: () => NOW, maxQuakes: 100 });
    feed(store, history);
    const { quakes } = store.snapshot(NOW);
    // 50報が同一地震ごとにまとまり、報の数より少なくなる
    expect(quakes.length).toBeGreaterThan(0);
    expect(quakes.length).toBeLessThan(history.length);
    // 新しい順
    const times = quakes.map((q) => q.occurredAt ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('後の報で震源が訂正される（M7.4 → M7.6）', () => {
    const store = new EventStore({ now: () => NOW });
    feed(store, quake);
    const noto = store
      .snapshot(NOW)
      .quakes.find((q) => q.key === '2024/01/01 16:10:00');
    expect(noto).toBeDefined();
    expect(noto!.hypocenter.magnitude).toBe(7.6);
    expect(noto!.maxIntensity).toEqual({ value: 70, label: '7' });
    expect(noto!.points.length).toBe(2829);
    expect(noto!.pointsAreArea).toBe(false);
  });

  it('順序が逆転しても新しい報の内容が残る', () => {
    const forward = new EventStore({ now: () => NOW });
    feed(forward, quake);
    const reverse = new EventStore({ now: () => NOW });
    feed(reverse, [...quake].reverse());

    const pick = (s: EventStore) =>
      s.snapshot(NOW).quakes.find((q) => q.key === '2024/01/01 16:10:00')!;
    expect(pick(reverse).hypocenter.magnitude).toBe(
      pick(forward).hypocenter.magnitude,
    );
    expect(pick(reverse).points.length).toBe(pick(forward).points.length);
  });

  it('震源のない震度速報が、既に判明した震源を消さない', () => {
    const store = new EventStore({ now: () => NOW });
    // 各地の震度（震源あり）→ 震度速報（震源なし）の順で届く
    const detail = quake.find(
      (r) => (r['issue'] as { type: string }).type === 'DetailScale',
    )!;
    const prompt = quake.find(
      (r) => (r['issue'] as { type: string }).type === 'ScalePrompt',
    )!;
    store.ingest(p2p(detail));
    store.ingest(p2p(prompt));
    const q = store.snapshot(NOW).quakes[0]!;
    expect(q.hypocenter.lat).not.toBeNull();
    expect(q.hypocenter.magnitude).not.toBeNull();
    // 詳しい観測点別の震度も、区域別の速報に上書きされない
    expect(q.pointsAreArea).toBe(false);
    expect(q.points.length).toBeGreaterThan(100);
  });

  it('種別ごとに情報を持ち寄る（震源だけの報＋震度だけの報）', () => {
    const store = new EventStore({ now: () => NOW });
    const time = '2026/08/16 18:00:00';
    store.ingest(
      p2p({
        code: 551,
        id: 'a',
        time: '2026/08/16 18:01:00.000',
        issue: { type: 'ScalePrompt', time: '2026/08/16 18:01:00' },
        earthquake: {
          time,
          maxScale: 30,
          hypocenter: {
            name: '',
            latitude: -200,
            longitude: -200,
            depth: -1,
            magnitude: -1,
          },
        },
        points: [{ addr: '茨城県北部', pref: '茨城県', isArea: true, scale: 30 }],
      }),
    );
    store.ingest(
      p2p({
        code: 551,
        id: 'b',
        time: '2026/08/16 18:03:00.000',
        issue: { type: 'Destination', time: '2026/08/16 18:03:00' },
        earthquake: {
          time,
          maxScale: -1,
          hypocenter: {
            name: '茨城県沖',
            latitude: 36.5,
            longitude: 141.0,
            depth: 40,
            magnitude: 4.8,
          },
        },
        points: [],
      }),
    );

    const q = store.snapshot(NOW).quakes[0]!;
    // Destination が震源を、ScalePrompt が震度を持ち込んでいる
    expect(q.hypocenter.name).toBe('茨城県沖');
    expect(q.hypocenter.magnitude).toBe(4.8);
    expect(q.maxIntensity).toEqual({ value: 30, label: '3' });
    expect(q.points).toHaveLength(1);
    expect(q.pointsAreArea).toBe(true);
    expect(q.issueTypes).toEqual(['ScalePrompt', 'Destination']);
    expect(q.reportIds).toEqual(['a', 'b']);
  });

  it('同じ id の報は1回しか取り込まない', () => {
    const store = new EventStore({ now: () => NOW });
    expect(store.ingest(p2p(history[0]!))).toBe(true);
    expect(store.ingest(p2p(history[0]!))).toBe(false);
    expect(store.snapshot(NOW).discarded).toBe(1);
  });
});

describe('EEWの重複排除', () => {
  const base = {
    type: 'jma_eew',
    Title: '緊急地震速報（予報）',
    EventID: '20260816133738',
    Serial: 2,
    AnnouncedTime: '2026/08/16 18:59:50',
    OriginTime: '2026/08/16 18:59:40',
    Hypocenter: '日向灘',
    Latitude: 32.0,
    Longitude: 132.1,
    Magunitude: 3.8,
    Depth: 30,
    MaxIntensity: '2',
    Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: '', Magnitude: '' },
    isWarn: false,
    isFinal: false,
    isCancel: false,
    isTraining: false,
    isAssumption: false,
    isSea: true,
    WarnArea: [],
    OriginalText: '37 03 00 ...',
  };
  const wolfx = (patch: Record<string, unknown>) =>
    parseWolfxMessage({ ...base, ...patch }, {
      receivedAt: NOW,
      now: NOW,
    }) as EewEvent;

  it('serial が進んだ報で更新する', () => {
    const store = new EventStore({ now: () => NOW });
    store.ingest(wolfx({ Serial: 2 }));
    expect(store.ingest(wolfx({ Serial: 3, MaxIntensity: '4' }))).toBe(true);
    expect(store.getActiveEew(NOW)!.maxIntensity!.label).toBe('4');
  });

  it('serial が戻った報は破棄する（順序逆転）', () => {
    const store = new EventStore({ now: () => NOW });
    store.ingest(wolfx({ Serial: 3, MaxIntensity: '4' }));
    expect(store.ingest(wolfx({ Serial: 2, MaxIntensity: '1' }))).toBe(false);
    expect(store.getActiveEew(NOW)!.serial).toBe(3);
    expect(store.getActiveEew(NOW)!.maxIntensity!.label).toBe('4');
  });

  it('キャンセル報の後に来た報は破棄する', () => {
    const store = new EventStore({ now: () => NOW });
    store.ingest(wolfx({ Serial: 3, isCancel: true }));
    expect(store.ingest(wolfx({ Serial: 4 }))).toBe(false);
    expect(store.getActiveEew(NOW)!.isCancel).toBe(true);
  });

  it('WolfxとP2Pで同じEEWが来たら先着を採用する', () => {
    const store = new EventStore({ now: () => NOW });
    store.ingest(wolfx({ Serial: 1 }));
    const fromP2p = parseP2pMessage(
      {
        code: 556,
        id: 'p2p-1',
        time: '2026/08/16 18:59:51.000',
        cancelled: false,
        issue: {
          eventId: '20260816133738',
          serial: '1',
          time: '2026/08/16 18:59:50',
        },
        earthquake: {
          originTime: '2026/08/16 18:59:40',
          hypocenter: { depth: 30, latitude: 32, longitude: 132.1, magnitude: 3.8 },
        },
        areas: [{ name: '宮崎県北部平野部', scaleFrom: 40, scaleTo: 40 }],
      },
      { receivedAt: NOW, now: NOW },
    );
    expect(store.ingest(fromP2p)).toBe(false);
    expect(store.getActiveEew(NOW)!.receivedFrom).toBe('wolfx');
  });
});

describe('進行中のEEWの判定', () => {
  const eew = (patch: Record<string, unknown>, now: number) =>
    parseWolfxMessage(
      {
        EventID: 'E1',
        Serial: 1,
        AnnouncedTime: '2026/08/16 19:00:00',
        MaxIntensity: '4',
        Hypocenter: 'テスト',
        Latitude: 35,
        Longitude: 135,
        Depth: 10,
        Magunitude: 5,
        ...patch,
      },
      { receivedAt: now, now },
    ) as EewEvent;

  const T = Date.parse('2026-08-16T10:00:05Z'); // 19:00:05 JST

  it('直近の報は進行中', () => {
    const store = new EventStore({ now: () => T });
    store.ingest(eew({}, T));
    expect(store.getActiveEew(T)).not.toBeNull();
  });

  it('接続直後に投げ込まれた古い報で緊急表示にしない', () => {
    const later = T + 10 * 60_000;
    const store = new EventStore({ now: () => later });
    const historical = eew({}, later);
    expect(historical.historical).toBe(true);
    store.ingest(historical);
    expect(store.getActiveEew(later)).toBeNull();
    // 履歴としては残る
    expect(store.snapshot(later).recentEews).toHaveLength(1);
  });

  it('3分経てば進行中ではなくなる', () => {
    const store = new EventStore({ now: () => T });
    store.ingest(eew({}, T));
    expect(store.getActiveEew(T + 4 * 60_000)).toBeNull();
  });

  it('訓練報は進行中にしない', () => {
    const store = new EventStore({ now: () => T });
    store.ingest(eew({ isTraining: true }, T));
    expect(store.getActiveEew(T)).toBeNull();
  });
});

describe('パース失敗の可視化', () => {
  it('失敗を握り潰さず数える', () => {
    const store = new EventStore({ now: () => NOW });
    store.ingest(parseP2pMessage('{壊れている', { receivedAt: NOW, now: NOW }));
    const s = store.snapshot(NOW);
    expect(s.parseFailures).toBe(1);
    expect(s.lastParseFailure?.source).toBe('p2p');
  });
});
