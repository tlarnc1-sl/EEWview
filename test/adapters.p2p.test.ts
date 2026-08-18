import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseP2pMessage } from '../src/adapters/p2p';
import type { QuakeInfoEvent, TsunamiEvent } from '../src/types';

/**
 * 実データによるゴールデンテスト。
 * quake.json（能登半島地震＝極端な例）と history.json（通常運用）の**両方**を通す。
 * 片方だけだと必ず取りこぼす。
 */

const quake = JSON.parse(
  readFileSync(new URL('../fixtures/quake.json', import.meta.url), 'utf8'),
) as unknown[];
const history = JSON.parse(
  readFileSync(new URL('../fixtures/history.json', import.meta.url), 'utf8'),
) as unknown[];

const NOW = Date.parse('2026-08-16T10:00:00Z');
const parse = (raw: unknown) =>
  parseP2pMessage(raw, { receivedAt: NOW, now: NOW });

function quakeEvents(source: unknown[]): QuakeInfoEvent[] {
  return source
    .map((r) => parse(r))
    .filter((e): e is QuakeInfoEvent => e?.kind === 'quake');
}

describe('P2P adapter / fixtures', () => {
  it('history.json の50件すべてが地震情報として読める', () => {
    const events = quakeEvents(history);
    expect(history).toHaveLength(50);
    expect(events).toHaveLength(50);
    // パース失敗が1件も無いこと
    expect(history.map(parse).filter((e) => e?.kind === 'parse-failure')).toEqual([]);
  });

  it('history.json の発表種別の内訳が実測どおり', () => {
    const counts: Record<string, number> = {};
    for (const e of quakeEvents(history)) {
      counts[e.issueType] = (counts[e.issueType] ?? 0) + 1;
    }
    expect(counts).toEqual({
      DetailScale: 45,
      ScalePrompt: 2,
      Destination: 2,
      Foreign: 1,
    });
  });

  it('quake.json の4件すべてが地震情報として読める', () => {
    expect(quakeEvents(quake)).toHaveLength(4);
  });
});

describe('欠損センチネル', () => {
  it('ScalePrompt は震源が丸ごと無い（区域別の震度だけ持つ）', () => {
    const e = quakeEvents(history).find((x) => x.issueType === 'ScalePrompt');
    expect(e).toBeDefined();
    expect(e!.hypocenter).toEqual({
      name: null,
      lat: null,
      lon: null,
      depthKm: null,
      magnitude: null,
    });
    expect(e!.maxIntensity).not.toBeNull();
    expect(e!.points.every((p) => p.isArea)).toBe(true);
  });

  it('Foreign は震源があるのに深さだけ欠ける', () => {
    const e = quakeEvents(history).find((x) => x.issueType === 'Foreign');
    expect(e).toBeDefined();
    expect(e!.hypocenter.lat).not.toBeNull();
    expect(e!.hypocenter.lon).not.toBeNull();
    expect(e!.hypocenter.magnitude).not.toBeNull();
    // depth: -1 は欠損。震源そのものはあるので lat/lon を巻き添えにしない
    expect(e!.hypocenter.depthKm).toBeNull();
    // 震度情報は無い
    expect(e!.points).toEqual([]);
    expect(e!.maxIntensity).toBeNull();
  });

  it('南半球の負の緯度を欠損と誤判定しない', () => {
    const e = parse({
      code: 551,
      id: 'south',
      time: '2026/08/16 19:00:00.000',
      issue: { type: 'Foreign', time: '2026/08/16 19:00:00' },
      earthquake: {
        time: '2026/08/16 18:50:00',
        maxScale: -1,
        hypocenter: {
          name: 'ニュージーランド付近',
          latitude: -41.3,
          longitude: 174.8,
          depth: -1,
          magnitude: 6.2,
        },
      },
      points: [],
    }) as QuakeInfoEvent;
    expect(e.hypocenter.lat).toBe(-41.3);
    expect(e.hypocenter.lon).toBe(174.8);
    expect(e.hypocenter.depthKm).toBeNull();
  });

  it('depth: 0 は「ごく浅い」であって不明ではない', () => {
    const e = parse({
      code: 551,
      id: 'shallow',
      time: '2026/08/16 19:00:00.000',
      issue: { type: 'DetailScale', time: '2026/08/16 19:00:00' },
      earthquake: {
        time: '2026/08/16 18:50:00',
        maxScale: 20,
        hypocenter: {
          name: 'テスト',
          latitude: 35,
          longitude: 135,
          depth: 0,
          magnitude: 3,
        },
      },
      points: [],
    }) as QuakeInfoEvent;
    expect(e.hypocenter.depthKm).toBe(0);
  });

  it('Destination と Foreign は points が空で maxScale が -1', () => {
    for (const type of ['Destination', 'Foreign'] as const) {
      const events = quakeEvents(history).filter((x) => x.issueType === type);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.points).toEqual([]);
        expect(e.maxIntensity).toBeNull();
        // 震源はある
        expect(e.hypocenter.lat).not.toBeNull();
      }
    }
  });
});

describe('震度スケール', () => {
  it('scale 46 は「5弱以上」として読める', () => {
    const events = quakeEvents(quake);
    const all = events.flatMap((e) => e.points);
    const unknownable = all.filter((p) => p.intensity?.value === 46);
    expect(unknownable.length).toBeGreaterThan(0);
    expect(unknownable[0]!.intensity!.label).toBe('5弱以上');
    // ソート用の数値としては 45 と 50 の間
    expect(unknownable[0]!.intensity!.value).toBeGreaterThan(45);
    expect(unknownable[0]!.intensity!.value).toBeLessThan(50);
  });

  it('実データに現れる震度値がすべてラベルを持つ', () => {
    const events = [...quakeEvents(quake), ...quakeEvents(history)];
    const rawScales = new Set<number>();
    for (const raw of [...quake, ...history]) {
      for (const p of (raw as { points?: { scale: number }[] }).points ?? []) {
        rawScales.add(p.scale);
      }
    }
    const parsedLabels = new Set(
      events.flatMap((e) => e.points.map((p) => p.intensity?.label ?? 'null')),
    );
    expect(parsedLabels.has('null')).toBe(false);
    expect(rawScales.size).toBeGreaterThan(3);
  });
});

describe('時刻', () => {
  it('地震情報の発震時刻は分単位（秒は常に0）', () => {
    // 気象庁の発表自体が分単位。秒を持つのはEEWの OriginTime だけ
    for (const raw of [...history, ...quake]) {
      const e = parse(raw) as QuakeInfoEvent;
      if (e.occurredAt === null) continue;
      expect(new Date(e.occurredAt).getUTCSeconds()).toBe(0);
    }
  });

  it('JSTとして解釈する（ローカルタイムゾーンに依存しない）', () => {
    const e = quakeEvents(quake)[0]!;
    // 2024/01/01 16:10:00 JST = 07:10:00 UTC
    expect(new Date(e.occurredAt!).toISOString()).toBe('2024-01-01T07:10:00.000Z');
  });

  it('ミリ秒の桁数が揺れてもパースできる', () => {
    // "18:08:54.4" は 400ms であって 4ms ではない
    const e = parse({
      code: 551,
      id: 'ms',
      time: '2026/08/16 18:08:54.4',
      issue: { type: 'DetailScale', time: '2026/08/16 18:08:54.4' },
      earthquake: { time: '2026/08/16 18:08:00', maxScale: 10, hypocenter: {} },
      points: [],
    }) as QuakeInfoEvent;
    expect(new Date(e.issuedAt!).toISOString()).toBe('2026-08-16T09:08:54.400Z');
  });
});

describe('未知・欠損フィールドへの耐性', () => {
  it('仕様に無いフィールドがあっても壊れない', () => {
    const withExtras = {
      ...(history[0] as Record<string, unknown>),
      未知のフィールド: { nested: [1, 2, 3] },
      created_at: '2026/08/16 18:00:00.000',
    };
    expect(parse(withExtras)?.kind).toBe('quake');
  });

  it('comments が null でも {freeFormComment} でも読める', () => {
    const events = quakeEvents(history);
    expect(events.every((e) => e.freeFormComment === null)).toBe(true);
    const withComment = parse({
      ...(history[0] as Record<string, unknown>),
      comments: { freeFormComment: 'テスト' },
    }) as QuakeInfoEvent;
    expect(withComment.freeFormComment).toBe('テスト');
  });

  it('壊れたJSONは例外ではなく parse-failure になる', () => {
    expect(parse('{壊れている')?.kind).toBe('parse-failure');
  });

  it('無視するコードは null（エラーではない）', () => {
    for (const code of [555, 561, 9611]) {
      expect(parse({ code, id: 'x', time: '2026/08/16 19:00:00.000' })).toBeNull();
    }
  });
});

describe('津波予報', () => {
  it('解除報を読める', () => {
    const e = parse({
      code: 552,
      id: 'tsunami-cancel',
      time: '2026/08/16 19:05:29.069',
      cancelled: true,
      areas: [],
      issue: { source: '気象庁', time: '2023/10/09 12:00:02', type: 'Focus' },
    }) as TsunamiEvent;
    expect(e.kind).toBe('tsunami');
    expect(e.cancelled).toBe(true);
    expect(e.areas).toEqual([]);
  });

  it('到達予想時刻を時刻として読む', () => {
    const e = parse({
      code: 552,
      id: 'tsunami-time',
      time: '2026/08/16 19:05:29.069',
      cancelled: false,
      issue: { source: '気象庁', time: '2026/08/16 19:05:00', type: 'Focus' },
      areas: [
        {
          name: '岩手県',
          grade: 'MajorWarning',
          immediate: false,
          firstHeight: { arrivalTime: '2026/08/16 19:40:00' },
          maxHeight: { description: '１０ｍ超', value: 10 },
        },
      ],
    }) as TsunamiEvent;
    expect(new Date(e.areas[0]!.arrivalAt!).toISOString()).toBe(
      '2026-08-16T10:40:00.000Z',
    );
    expect(e.areas[0]!.condition).toBeNull();
  });

  it('区域つきの予報を読める', () => {
    const e = parse({
      code: 552,
      id: 'tsunami',
      time: '2026/08/16 19:05:29.069',
      cancelled: false,
      issue: { source: '気象庁', time: '2026/08/16 19:05:00', type: 'Focus' },
      areas: [
        {
          firstHeight: { condition: '津波到達中と推測' },
          grade: 'Watch',
          immediate: true,
          maxHeight: { description: '１ｍ', value: 1 },
          name: '千葉県九十九里・外房',
        },
      ],
    }) as TsunamiEvent;
    expect(e.areas[0]).toEqual({
      name: '千葉県九十九里・外房',
      grade: 'Watch',
      immediate: true,
      maxHeight: '１ｍ',
      // 到達予想時刻と状況は分けて持つ（「いつ来るか」を大きく出すため）
      arrivalAt: null,
      condition: '津波到達中と推測',
    });
  });
});

describe('EEWは扱わない（Wolfx一本）', () => {
  const sample556 = {
    code: 556,
    id: '6a69fdf1e88ee598246bf002',
    time: '2026/07/29 22:19:45.168',
    cancelled: false,
    issue: { eventId: '20260729221939', serial: '1', time: '2026/07/29 22:19:44' },
    earthquake: {
      originTime: '2026/07/29 22:19:36',
      hypocenter: { depth: 10, latitude: 32.4, longitude: 130.5, magnitude: 4.5, name: '日向灘' },
    },
    areas: [{ name: '熊本県熊本', pref: '熊本', scaleFrom: 45, scaleTo: 45 }],
  };

  it('556（EEW）は黙って捨てる。エラーにはしない', () => {
    // 経路を2つ持つと先着の採用や重複の始末が要る。EEWはWolfxだけから取る
    expect(parse(sample556)).toBeNull();
  });

  it('554（発表検出）も捨てる', () => {
    expect(
      parse({ code: 554, id: 'x', time: '2026/07/29 22:19:45.196', type: 'Full' }),
    ).toBeNull();
  });

  it('捨てても解析失敗として数えない', () => {
    for (const raw of [sample556, { code: 554, id: 'y', time: '2026/07/29 22:19:45.196' }]) {
      expect(parse(raw)?.kind).not.toBe('parse-failure');
    }
  });
});
