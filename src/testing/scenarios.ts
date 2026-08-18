import type { SourceId } from '../types';
import { formatJstStamp } from '../util/jst';
import warnSample from '../../fixtures/wolfx_warn.json';

/**
 * 動作確認用の電文。
 *
 * **正規化済みのイベントを作るのではなく、APIが送ってくるのと同じ生JSONを作る。**
 * それを実接続と同じ入口（adapters → store → UI）に流す。
 * 表示だけ差し替える作りにすると、確かめたいところ（パース・重複排除・
 * 履歴判定・描画）を全部飛ばしてしまい、動作確認にならない。
 *
 * EEWの警報級イベントは年に数回しか来ない。津波はもっと少ない。
 * それを待たずに経路を通すためのもの。
 */

export interface ScenarioStep {
  /** 投入元。実接続と同じ source を名乗る */
  source: SourceId;
  /** 生JSON（文字列ではなくオブジェクトのまま。adapterはどちらも読める） */
  payload: unknown;
  /** シナリオ開始からの遅延（ミリ秒） */
  delayMs: number;
}

export interface Scenario {
  id: string;
  label: string;
  /** @param now 投入時刻。ここを基準に電文の時刻を組み立てる */
  build(now: number): ScenarioStep[];
}

/**
 * 土台にする実データ（2026/04/01 茨城県南部 M5.1、第12報の警報）。
 *
 * 合成データを別に持たず、**実際に流れた報をそのまま使う**。
 * 変えるのは EventID と時刻、そして「報を重ねる」ために必要な値だけ
 * （報番号・規模・予測震度・警報かどうか・対象地域の有無）。
 * 生電文（RK44559 など）も実物のまま流れる。
 */
const REAL_WARN = warnSample as Record<string, unknown>;

/**
 * 発震を「これから」に置く余裕。
 * 地震が起きる少し前から始めることで、予報円が0から広がる様子と、
 * 第1報が届くまでの数秒の空白まで再現できる。
 */
const ORIGIN_LEAD_MS = 2_000;

interface ForecastStep {
  serial: number;
  magnitude: number;
  intensity: string;
  warn: boolean;
  final: boolean;
  /** 発震からの秒数。実データの第12報は発震から56秒後（10:06:17 → 10:07:13） */
  fromOriginSec: number;
}

/**
 * 予報から警報への連続報。第12報が実データそのもの。
 *
 * EventID は実物と変えて毎回一意にする。同じIDのままだと、2回目に流したときに
 * 報番号が戻って（12 → 1）重複排除で捨てられ、何も起きない。
 */
function wolfxForecast(now: number): ScenarioStep[] {
  const eventId = `T${formatJstStamp(now).replace(/[/: ]/g, '').slice(2)}`;
  // 発震は少し先。始めた直後はまだ地震が起きていない状態から入る
  const originAt = now + ORIGIN_LEAD_MS;
  const originTime = formatJstStamp(originAt);

  const steps: ForecastStep[] = [
    { serial: 1, magnitude: 4.3, intensity: '3', warn: false, final: false, fromOriginSec: 4 },
    { serial: 4, magnitude: 4.9, intensity: '4', warn: false, final: false, fromOriginSec: 12 },
    { serial: 8, magnitude: 5.0, intensity: '5-', warn: true, final: false, fromOriginSec: 30 },
    // ここが実データの第12報（MaxIntensity は "5弱" 表記のまま）
    { serial: 12, magnitude: 5.1, intensity: '5弱', warn: true, final: true, fromOriginSec: 56 },
  ];

  return steps.map((step) => ({
    source: 'wolfx' as const,
    delayMs: ORIGIN_LEAD_MS + step.fromOriginSec * 1_000,
    payload: {
      ...REAL_WARN,
      EventID: eventId,
      Serial: step.serial,
      // 発表時刻は発震からの経過で決まる。履歴扱いにならないよう常に「いま」基準
      AnnouncedTime: formatJstStamp(originAt + step.fromOriginSec * 1_000),
      OriginTime: originTime,
      Magunitude: step.magnitude,
      MaxIntensity: step.intensity,
      // 気象庁が付けるタイトル。切り替わるとここも変わる
      Title: step.warn ? '緊急地震速報（警報）' : '緊急地震速報（予報）',
      isWarn: step.warn,
      isFinal: step.final,
      // 対象地域が載るのは警報から
      WarnArea: step.warn ? REAL_WARN['WarnArea'] : [],
    },
  }));
}

/** 予報のあとに取消が来る場合。取消後の報を捨てる経路も通る */
function wolfxCancel(now: number): ScenarioStep[] {
  const forecast = wolfxForecast(now).slice(0, 2);
  const first = forecast[0]!.payload as Record<string, unknown>;
  return [
    ...forecast,
    {
      source: 'wolfx',
      delayMs: 20_000,
      payload: {
        ...first,
        Title: '緊急地震速報（取消）',
        Serial: 20,
        AnnouncedTime: formatJstStamp(now + 20_000),
        isCancel: true,
        isFinal: true,
        MaxIntensity: '',
        WarnArea: [],
      },
    },
    {
      // 取消のあとに届いた報。破棄されるのが正しい
      source: 'wolfx',
      delayMs: 26_000,
      payload: {
        ...first,
        Serial: 21,
        AnnouncedTime: formatJstStamp(now + 26_000),
        MaxIntensity: '5+',
      },
    },
  ];
}

/**
 * 深発地震。深いぶん、震央直上に波が届くまでの待ちが長く、
 * 円が出てくるのが遅れる。走時表は700kmまで値を持つので円は描かれる。
 */
function deepQuake(now: number): ScenarioStep[] {
  const [first] = wolfxForecast(now);
  const base = first!.payload as Record<string, unknown>;
  return [
    {
      source: 'wolfx',
      delayMs: 0,
      payload: {
        ...base,
        EventID: `D${formatJstStamp(now).replace(/[/: ]/g, '').slice(2)}`,
        Hypocenter: '宮城県沖',
        Latitude: 38.3,
        Longitude: 142.2,
        Depth: 170,
        Magunitude: 6.4,
        MaxIntensity: '4',
      },
    },
  ];
}

/**
 * PLUM法の報。予報円は出ず、震央は×印ではなくぼんやり光る円になる。
 * 震源を決める手法ではないので、震源から広がる波として描けない。
 */
function plumQuake(now: number): ScenarioStep[] {
  const [first] = wolfxForecast(now);
  const base = first!.payload as Record<string, unknown>;
  return [
    {
      source: 'wolfx',
      delayMs: 0,
      payload: {
        ...base,
        EventID: `P${formatJstStamp(now).replace(/[/: ]/g, '').slice(2)}`,
        Depth: 10,
        MaxIntensity: '5-',
        isWarn: true,
        Title: '緊急地震速報（警報）',
        Accuracy: { Epicenter: 'PLUM 法', Depth: 'PLUM 法', Magnitude: '不明' },
        // RKの1桁目を 9（PLUM法）にする。判定は文字列ではなくこれを見る
        OriginalText: `37 03 00 ${formatJstStamp(now).replace(/[/: ]/g, '').slice(2)} C11 ... RK94209 RT01/// RC0//// 9999=`,
        isAssumption: true,
      },
    },
  ];
}

interface TsunamiAreaSpec {
  name: string;
  grade: string;
  immediate?: boolean;
  height?: string;
  condition?: string;
}

function tsunamiPayload(now: number, areas: TsunamiAreaSpec[], cancelled = false) {
  return {
    code: 552,
    id: `test-552-${now}`,
    time: formatJstStamp(now, true),
    cancelled,
    issue: { source: '気象庁', time: formatJstStamp(now), type: 'Focus' },
    areas: areas.map((a) => ({
      name: a.name,
      grade: a.grade,
      immediate: a.immediate ?? false,
      firstHeight: a.condition ? { condition: a.condition } : { arrivalTime: formatJstStamp(now + 600_000) },
      maxHeight: a.height ? { description: a.height, value: 1 } : undefined,
    })),
  };
}

/** 津波予報（Watch）。いちばん軽い階級 */
function tsunamiWatch(now: number): ScenarioStep[] {
  return [
    {
      source: 'p2p',
      delayMs: 0,
      payload: tsunamiPayload(now, [
        { name: '宮崎県', grade: 'Watch', height: '１ｍ', immediate: true, condition: '津波到達中と推測' },
        { name: '高知県', grade: 'Watch', height: '１ｍ' },
        { name: '大分県豊後水道沿岸', grade: 'Watch', height: '０．２ｍ' },
      ]),
    },
  ];
}

/** 重い階級。区域が多い場合の並びと高さの表示を見る */
function tsunamiMajor(now: number): ScenarioStep[] {
  return [
    {
      source: 'p2p',
      delayMs: 0,
      payload: tsunamiPayload(now, [
        { name: '岩手県', grade: 'MajorWarning', height: '１０ｍ超', immediate: true, condition: '津波到達中と推測' },
        { name: '宮城県', grade: 'MajorWarning', height: '１０ｍ超', immediate: true },
        { name: '福島県', grade: 'Warning', height: '３ｍ' },
        { name: '青森県太平洋沿岸', grade: 'Warning', height: '３ｍ' },
        { name: '茨城県', grade: 'Warning', height: '３ｍ' },
        { name: '千葉県九十九里・外房', grade: 'Watch', height: '１ｍ' },
        { name: '北海道太平洋沿岸東部', grade: 'Watch', height: '１ｍ' },
      ]),
    },
  ];
}

/** 解除。列が畳まれて元の位置に戻るところを見る */
function tsunamiCancel(now: number): ScenarioStep[] {
  return [
    { source: 'p2p', delayMs: 0, payload: tsunamiPayload(now, [], true) },
  ];
}

/**
 * 警報級のEEWと津波が同時に進行する場合。
 * EEWのカードに津波の帯が載り、ハザードストライプも出る状態を見る。
 */
function warnWithTsunami(now: number): ScenarioStep[] {
  return [
    ...wolfxForecast(now),
    { source: 'p2p', delayMs: 40_000, payload: tsunamiPayload(now, [
      { name: '宮崎県', grade: 'MajorWarning', height: '１０ｍ超', immediate: true, condition: '津波到達中と推測' },
      { name: '高知県', grade: 'Warning', height: '３ｍ' },
    ]) },
  ];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'eew-forecast',
    label: '茨城県南部 M5.1（予報→警報 実データ）',
    build: wolfxForecast,
  },
  { id: 'eew-cancel', label: '予報のあと取消', build: wolfxCancel },
  { id: 'eew-deep', label: '深発地震 170km（円の出現が遅い）', build: deepQuake },
  { id: 'eew-plum', label: 'PLUM法（予報円なし・円の点滅）', build: plumQuake },
  { id: 'tsunami-watch', label: '津波 Watch 3区域', build: tsunamiWatch },
  { id: 'tsunami-major', label: '津波 MajorWarning 7区域', build: tsunamiMajor },
  { id: 'tsunami-cancel', label: '津波 解除', build: tsunamiCancel },
  { id: 'warn-tsunami', label: '警報＋大津波警報（同時）', build: warnWithTsunami },
];
