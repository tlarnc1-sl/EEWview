import { describe, expect, it } from 'vitest';
import {
  parseWolfxMessage,
  isUnreliableEpicenter,
  readWolfxServerTime,
} from '../src/adapters/wolfx';
import type { EewEvent } from '../src/types';
import { readFileSync } from 'node:fs';

/** 実際に流れた警報の報（2026/04/01 茨城県南部 M5.1、第12報） */
const WARN = JSON.parse(
  readFileSync(new URL('../fixtures/wolfx_warn.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const SAMPLE = {
  type: 'jma_eew',
  Title: '緊急地震速報（予報）',
  CodeType: 'Ｍ、最大予測震度及び主要動到達予測時刻の緊急地震速報',
  Issue: { Source: '東京', Status: '通常' },
  EventID: '20260402005943',
  Serial: 8,
  AnnouncedTime: '2026/04/02 01:00:15',
  OriginTime: '2026/04/02 00:59:41',
  Hypocenter: '紀伊水道',
  Latitude: 34.2,
  Longitude: 135.1,
  Magunitude: 3.7,
  Depth: 10,
  MaxIntensity: '3',
  Accuracy: {
    Epicenter: 'IPF 法（5 点以上）',
    Depth: 'IPF 法（5 点以上）',
    Magnitude: '全点全相',
  },
  MaxIntChange: { String: 'ほとんど変化なし', Reason: '不明、未設定時、キャンセル時' },
  WarnArea: [],
  isSea: true,
  isTraining: false,
  isAssumption: false,
  isWarn: false,
  isFinal: true,
  isCancel: false,
  OriginalText: '37 03 00 260402010015 C11 ... 9999=',
  Pond: '127',
};

const NOW = Date.parse('2026-04-01T16:00:20Z'); // = 2026/04/02 01:00:20 JST
const parse = (raw: unknown, now = NOW) =>
  parseWolfxMessage(raw, { receivedAt: now, now });

describe('Wolfx adapter', () => {
  it('実データの各フィールドを正規化できる', () => {
    const e = parse(SAMPLE) as EewEvent;
    expect(e.kind).toBe('eew');
    expect(e.eventId).toBe('20260402005943');
    expect(e.serial).toBe(8);
    expect(e.receivedFrom).toBe('wolfx');
    expect(e.title).toBe('緊急地震速報（予報）');
    expect(e.hypocenter).toEqual({
      name: '紀伊水道',
      lat: 34.2,
      lon: 135.1,
      depthKm: 10,
      // Magunitude（API側の綴り誤り）から読む
      magnitude: 3.7,
    });
    expect(e.maxIntensity).toEqual({ value: 30, label: '3' });
    expect(e.isFinal).toBe(true);
    expect(e.isSea).toBe(true);
    expect(e.originalText).toBe(SAMPLE.OriginalText);
  });

  it('MaxIntensity の 5-/5+ 表記を数値と表示に分けて持つ', () => {
    const weak = parse({ ...SAMPLE, MaxIntensity: '5-' }) as EewEvent;
    const strong = parse({ ...SAMPLE, MaxIntensity: '5+' }) as EewEvent;
    expect(weak.maxIntensity).toEqual({ value: 45, label: '5弱' });
    expect(strong.maxIntensity).toEqual({ value: 50, label: '5強' });
    expect(strong.maxIntensity!.value).toBeGreaterThan(weak.maxIntensity!.value);
  });

  it('タイムゾーン情報のない時刻をJSTとして解釈する', () => {
    const e = parse(SAMPLE) as EewEvent;
    expect(new Date(e.announcedAt!).toISOString()).toBe('2026-04-01T16:00:15.000Z');
    expect(new Date(e.originAt!).toISOString()).toBe('2026-04-01T15:59:41.000Z');
  });

  it('文字列で来ても読める', () => {
    const e = parse(JSON.stringify(SAMPLE)) as EewEvent;
    expect(e.eventId).toBe('20260402005943');
  });

  it('ハートビートはイベントではない', () => {
    // 本番の実データ（2026-08-16 実測）
    expect(
      parse({ type: 'heartbeat', ver: 22, id: '1824853', timestamp: 1786879289030 }),
    ).toBeNull();
    expect(parse({ type: 'pong', timestamp: 1786879289054 })).toBeNull();
  });

  it('未知のフィールドが増えても壊れない', () => {
    const e = parse({ ...SAMPLE, NewFieldFromFuture: { a: 1 }, Serial: 9 }) as EewEvent;
    expect(e.serial).toBe(9);
  });

  it('壊れたJSONは parse-failure', () => {
    expect(parse('not json')?.kind).toBe('parse-failure');
  });
});

describe('サーバー時刻の取り出し', () => {
  it('pong から時刻を取る（往復が分かるので時刻推定に使える）', () => {
    expect(
      readWolfxServerTime('{"type":"pong","timestamp":1786879289054}'),
    ).toEqual({ serverTime: 1786879289054, isPong: true });
  });

  it('ハートビートからも取れるが pong とは区別する', () => {
    expect(
      readWolfxServerTime({
        type: 'heartbeat',
        ver: 22,
        id: '1824853',
        timestamp: 1786879289030,
      }),
    ).toEqual({ serverTime: 1786879289030, isPong: false });
  });

  it('EEW本体やゴミからは取らない', () => {
    expect(readWolfxServerTime(SAMPLE)).toBeNull();
    expect(readWolfxServerTime('壊れている')).toBeNull();
    expect(readWolfxServerTime({ type: 'pong' })).toBeNull();
    // 秒単位の値を誤ってミリ秒として使わない
    expect(readWolfxServerTime({ type: 'pong', timestamp: 1786879289 })).toBeNull();
  });
});

describe('接続直後に投げ込まれる古い報', () => {
  it('3分以内の報は新着', () => {
    const e = parse(SAMPLE) as EewEvent;
    expect(e.historical).toBe(false);
  });

  it('3分より前の報は履歴扱い', () => {
    const later = Date.parse('2026-04-01T16:10:00Z');
    const e = parse(SAMPLE, later) as EewEvent;
    expect(e.historical).toBe(true);
  });
});

describe('震源の確からしさ（次フェーズの前提条件）', () => {
  it('IPF法の報は震源に基づく計算をしてよい', () => {
    const e = parse(SAMPLE) as EewEvent;
    expect(e.epicenterReliable).toBe(true);
  });

  it('PLUM法・レベル法・未定・不明の報は計算に使わない', () => {
    for (const acc of ['PLUM 法', 'レベル法', '未定', '不明']) {
      const e = parse({
        ...SAMPLE,
        Accuracy: { ...SAMPLE.Accuracy, Epicenter: acc },
      }) as EewEvent;
      expect(e.epicenterReliable, acc).toBe(false);
    }
    expect(isUnreliableEpicenter(null)).toBe(true);
  });

  it('仮定震源要素（isAssumption）の報は計算に使わない', () => {
    const e = parse({ ...SAMPLE, isAssumption: true }) as EewEvent;
    expect(e.epicenterReliable).toBe(false);
    expect(e.isAssumption).toBe(true);
  });
});

describe('実データ / 予報から切り替わった報', () => {
  const WARN_NOW = Date.parse('2026-04-01T01:07:20Z'); // 2026/04/01 10:07:20 JST
  const parseWarn = () =>
    parseWolfxMessage(WARN, { receivedAt: WARN_NOW, now: WARN_NOW }) as EewEvent;

  it('MaxIntensity が「5弱」表記でも読める（"5-" とは限らない）', () => {
    // 実データはこの表記だった。両方の書き方を受ける
    expect(WARN['MaxIntensity']).toBe('5弱');
    expect(parseWarn().maxIntensity).toEqual({ value: 45, label: '5弱' });
  });

  it('切り替わりの印が立つ', () => {
    const e = parseWarn();
    expect(e.isWarn).toBe(true);
    expect(e.isFinal).toBe(true);
    expect(e.serial).toBe(12);
    // 気象庁のタイトルはそのまま持つ
    expect(e.title).toBe('緊急地震速報（警報）');
  });

  it('対象地域を予測震度つきで読む', () => {
    const areas = parseWarn().warnAreas;
    expect(areas).toHaveLength(7);
    expect(areas[0]).toEqual({
      name: '栃木県南部',
      upper: { value: 45, label: '5弱' },
      lower: { value: 45, label: '5弱' },
      arrive: '主要動到達時刻の予測なし（PLUM 法による予測）',
      arriveTimeRaw: '100639',
    });
  });

  it('上限と下限が違う地域も読める', () => {
    const area = parseWarn().warnAreas.find((a) => a.name === '埼玉県北部')!;
    // Shindo1 が上限、Shindo2 が下限
    expect(area.upper).toEqual({ value: 40, label: '4' });
    expect(area.lower).toEqual({ value: 30, label: '3' });
  });

  it('到達予測時刻の埋め字 "//////" を時刻として読まない', () => {
    const area = parseWarn().warnAreas.find((a) => a.name === '埼玉県南部')!;
    expect(area.arriveTimeRaw).toBeNull();
    expect(area.arrive).toBe('既に到達と予測');
  });

  it('地域ごとがPLUM法でも、震源そのものはIPF法なら信用してよい', () => {
    const e = parseWarn();
    // Arrive に PLUM とあるのは、その地域の予測手法の話。
    // 震源の確からしさは Accuracy.Epicenter で判断する
    expect(e.accuracy?.epicenter).toBe('IPF 法（5 点以上）');
    expect(e.epicenterReliable).toBe(true);
  });

  it('震央の確からしさを電文のコードから読む', () => {
    // RK44559 の1桁目 = 4（IPF法5点以上）。Accuracy.Epicenter の和訳と一致する
    const e = parseWarn();
    expect(e.accuracy?.epicenterCode).toBe(4);
    expect(e.accuracy?.epicenter).toBe('IPF 法（5 点以上）');
    expect(e.epicenterReliable).toBe(true);
  });

  it('生電文をそのまま持ち回る', () => {
    expect(parseWarn().originalText).toContain('EBI');
    expect(parseWarn().originalText).toContain('9999=');
  });
});
