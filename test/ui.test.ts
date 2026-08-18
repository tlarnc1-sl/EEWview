// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { App } from '../src/ui/app';
import { EventStore } from '../src/store/store';
import { parseP2pMessage } from '../src/adapters/p2p';
import { parseWolfxMessage } from '../src/adapters/wolfx';
import type { ConnectionState } from '../src/transport/types';
import type { SourceId } from '../src/types';
import type { AppInput } from '../src/ui/app';
import { project } from '../src/ui/geo';
import { parseTravelTimeTable } from '../src/lib/travelTime';

// jsdom環境では import.meta.url が http になるので、cwd から引く
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(`${process.cwd()}/fixtures/${name}`, 'utf8'),
  ) as Record<string, unknown>[];

const quake = fixture('quake.json');
const history = fixture('history.json');

const NOW = Date.parse('2026-08-16T10:00:05Z'); // 19:00:05 JST

const EEW = {
  Title: '緊急地震速報（予報）',
  EventID: '20260816190000',
  Serial: 3,
  AnnouncedTime: '2026/08/16 19:00:00',
  OriginTime: '2026/08/16 18:59:50',
  Hypocenter: '日向灘',
  Latitude: 32.0,
  Longitude: 132.1,
  Magunitude: 5.8,
  Depth: 30,
  MaxIntensity: '5-',
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

function connection(source: SourceId, status: ConnectionState['status']): ConnectionState {
  return {
    source,
    status,
    lastMessageAt: status === 'open' ? NOW : null,
    since: NOW,
    attempt: 0,
    nextRetryAt: null,
    detail: null,
  };
}

function makeInput(store: EventStore, overrides: Partial<AppInput> = {}): AppInput {
  return {
    snapshot: store.snapshot(NOW),
    connections: new Map<SourceId, ConnectionState>([
      ['wolfx', connection('wolfx', 'open')],
      ['p2p', connection('p2p', 'open')],
    ]),
    clock: { status: 'ok', offsetMs: 120, samples: 3 },
    degradedReasons: [],
    ...overrides,
  };
}

let store: EventStore;
let app: App;

beforeEach(() => {
  document.body.replaceChildren();
  store = new EventStore({ now: () => NOW, maxQuakes: 100 });
  app = new App({ endpoint: 'wss://example.test/ws', environment: 'production' });
  document.body.appendChild(app.el);
});

const text = () => app.el.textContent ?? '';

describe('平常時', () => {
  it('EEWの列は開かない（場所を取らない）', () => {
    app.render(makeInput(store));
    expect(app.el.classList.contains('app--alert')).toBe(false);
    expect(app.el.classList.contains('app--eew')).toBe(false);
    expect(app.el.querySelector('.eew')).toBeNull();
  });

  it('ステータスと設定は右下に出す', () => {
    app.render(makeInput(store));
    const bar = app.el.querySelector('.main__side .statusbar')!;
    expect(bar.querySelector('.compact')).not.toBeNull();
    expect(bar.querySelector('.settings-button')).not.toBeNull();
  });

  it('津波の欄は常設しない（発表が無いときは場所を取らない）', () => {
    app.render(makeInput(store));
    expect(app.el.querySelector('.panel--tsunami')).toBeNull();
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
  });

  it('最近の地震が一覧の主役になる', () => {
    for (const raw of history.slice(0, 10)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    const rows = app.el.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('一覧に見出しは置かず、先頭の行を大きくする', () => {
    for (const raw of history.slice(0, 10)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));

    expect(app.el.querySelector('.panel--list .panel__title')).toBeNull();
    expect(app.el.textContent).not.toContain('最近の地震');

    const rows = [...app.el.querySelectorAll('.row')];
    expect(rows[0]!.classList.contains('row--first')).toBe(true);
    expect(rows[1]!.classList.contains('row--first')).toBe(false);
  });

  it('新しい地震が来たら、そこへ移る', () => {
    for (const raw of history.slice(0, 6)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));

    // 古いものを手で選ぶ
    const rows = [...app.el.querySelectorAll('.row')] as HTMLButtonElement[];
    const older = rows.findIndex((r, i) => i > 0 && r.textContent !== rows[0]!.textContent);
    rows[older]!.click();
    expect(app.el.querySelector('.panel--detail .panel__title')!.textContent).toBe(
      `詳細 ${rows[older]!.querySelector('.row__time')!.textContent}`,
    );

    // そこへ新着が届く
    store.ingest(
      parseP2pMessage(
        {
          code: 551,
          id: 'brand-new',
          time: '2026/08/16 19:30:10.000',
          issue: { type: 'DetailScale', time: '2026/08/16 19:30:10' },
          earthquake: {
            time: '2026/08/16 19:30:00',
            maxScale: 30,
            hypocenter: {
              name: '新しい地震',
              latitude: 36,
              longitude: 140,
              depth: 30,
              magnitude: 4.2,
            },
          },
          points: [{ addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 30 }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    // 最新に移っている（詳細の見出しは発震時刻で対応が取れる）
    expect(app.el.querySelector('.panel--detail')!.textContent).toContain('新しい地震');
  });

  it('一覧の行は、マグニチュードと深さを縦線で区切る（間隔ではない）', () => {
    for (const raw of history.slice(0, 4)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));

    const row = app.el.querySelector('.row')!;
    const values = [...row.querySelectorAll('.row__field')].map((el) => el.textContent);
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/^M/);
    expect(values[1]).toMatch(/深さ|ごく浅い/);
    // 観測点の数は一覧には出さない（詳細に出す）
    expect(row.textContent).not.toContain('観測点');
    expect(app.el.querySelector('.panel--detail')!.textContent).toMatch(/観測点別 \d+点/);
  });

  it('津波の有無は日本語で、震源名の行に出す（深さと時刻の間に割り込ませない）', () => {
    store.ingest(
      parseP2pMessage(
        {
          code: 551,
          id: 'with-tsunami',
          time: '2026/08/16 18:59:10.000',
          issue: { type: 'DetailScale', time: '2026/08/16 18:59:10' },
          earthquake: {
            time: '2026/08/16 18:59:00',
            maxScale: 55,
            domesticTsunami: 'Warning',
            hypocenter: {
              name: '福島県沖',
              latitude: 37.5,
              longitude: 142,
              depth: 40,
              magnitude: 7.4,
            },
          },
          points: [{ addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 55 }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const row = app.el.querySelector('.row')!;
    // 気象庁の階級名で出す（`Warning` では何のことか分からない）
    const mark = row.querySelector('.row__tsunami')!;
    expect(mark.textContent).toBe('津波警報');
    expect(row.textContent).not.toContain('Warning');
    // 震源名と同じ行。M・深さの欄には入れない
    expect(mark.closest('.row__head')).not.toBeNull();
    expect(row.querySelectorAll('.row__field')).toHaveLength(2);
  });

  it('津波なしの行には印を出さない（出ている行が目に入るように）', () => {
    for (const raw of history.slice(0, 3)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    expect(app.el.querySelector('.row__tsunami')).toBeNull();
  });

  it('地震情報の発震時刻は分単位で出す（秒は持っていない）', () => {
    for (const raw of history.slice(0, 2)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    // P2Pの earthquake.time は秒が常に 00。:00 と出すと持っていない精度に見える
    expect(app.el.querySelector('.row__time')!.textContent).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2}$/,
    );
  });

  it('一覧に番号は振らない。詳細の見出しは発震時刻で対応が取れる', () => {
    for (const raw of history.slice(0, 10)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));

    // 番号は出さない（一覧の行と詳細は時刻で突き合わせる）
    expect(app.el.querySelector('.row__index')).toBeNull();
    expect(app.el.querySelector('.panel--list')!.textContent).not.toMatch(/#\d/);

    const time = app.el.querySelector('.row__time')!.textContent!;
    const title = () => app.el.querySelector('.panel--detail .panel__title')!.textContent;
    expect(title()).toBe(`詳細 ${time}`);

    // 別のを選ぶと、詳細の見出しもその地震の時刻になる
    const rows = [...app.el.querySelectorAll('.row')] as HTMLButtonElement[];
    const other = rows.findIndex((r, i) => i > 0 && r.textContent !== rows[0]!.textContent);
    rows[other]!.click();
    const otherTime = rows[other]!.querySelector('.row__time')!.textContent!;
    expect(title()).toBe(`詳細 ${otherTime}`);
  });
});

describe('EEW受信中', () => {
  beforeEach(() => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
  });

  const card = () => app.el.querySelector('.eew')!;

  it('左に縦の列が開き、見出しに最大予測震度を出す', () => {
    expect(app.el.classList.contains('app--eew')).toBe(true);
    expect(app.el.classList.contains('app--alert')).toBe(true);

    const value = card().querySelector('.eew__intensity-value')!;
    // 「5弱」ではなく、数字と符号を分けて組む
    expect(value.textContent).toBe('5−');
    expect(value.querySelector('.int__num')!.textContent).toBe('5');
    expect(value.querySelector('.int__mod')!.textContent).toBe('−');
    // 気象庁の正式表記は title に残す
    expect(value.getAttribute('title')).toBe('5弱');
    // 震源やMより先に来る（DOM順＝視覚的な重み）
    const children = [...card().children].map((el) => el.className);
    expect(children[0]).toContain('eew__head');
    // 見出しの中。同じ形のバッジが並ぶので名前を付ける
    const head = card().querySelector('.eew__head')!;
    expect(head.contains(value)).toBe(true);
    expect(head.querySelector('.eew__label')!.textContent).toBe('最大予測');
  });

  it('カードの中にこの地点の推定を入れない（同じ形のバッジを隣に並べない）', () => {
    expect(card().querySelector('.estimate')).toBeNull();
    // 全国の最大予測だと分かるように名前を付ける
    expect(card().querySelector('.eew__label')!.textContent).toBe('最大予測');
  });

  it('震源・規模・報番号を添える', () => {
    const text = card().textContent ?? '';
    expect(text).toContain('緊急地震速報（予報）');
    expect(text).toContain('日向灘');
    expect(text).toContain('M5.8');
    expect(text).toContain('深さ30km');
    expect(text).toContain('第3報');
  });

  it('地図と一覧の位置は動かさない', () => {
    const layout = (root: HTMLElement) =>
      [...root.children].map((el) => `${el.tagName}.${el.className.split(' ')[0]}`);
    const alertLayout = layout(app.el);
    const alertMain = layout(app.el.querySelector('.main') as HTMLElement);

    const store2 = new EventStore({ now: () => NOW });
    const app2 = new App({ endpoint: 'wss://example.test/ws', environment: 'production' });
    app2.render(makeInput(store2));
    expect(layout(app2.el)).toEqual(alertLayout);
    expect(alertLayout).toEqual(['MAIN.main', 'DIV.settings', 'DIV.setup']);
    // **列は増えない。** EEWは地図に重ねるので、受信の前後で本体の列構成が同じ
    expect(layout(app2.el.querySelector('.main') as HTMLElement)).toEqual(alertMain);
    expect(alertMain).toEqual(['DIV.main__map', 'DIV.main__tsunami', 'ASIDE.main__side']);
  });

  it('EEWの枠と到達予測は地図の中に重ねる（列にしない）', () => {
    const overlay = app.el.querySelector('.eew-overlay') as HTMLElement;
    const hud = app.el.querySelector('.hud') as HTMLElement;
    // どちらも地図の領域の中にある
    expect(overlay.closest('.main__map')).not.toBeNull();
    expect(hud.closest('.main__map')).not.toBeNull();
    // 地図そのものと兄弟（地図の大きさに影響しない）
    expect(overlay.previousElementSibling?.classList.contains('map')).toBe(true);
  });

  it('震源マーカーが濃くなる', () => {
    const marker = app.el.querySelector('.map__epicenter')!;
    expect(marker.classList.contains('map__epicenter--alert')).toBe(true);
    // 震源が確定している報は×印
    expect(marker.querySelectorAll('line')).toHaveLength(2);
    expect(marker.querySelector('circle')).toBeNull();
  });

  it('PLUM法の震央は×印ではなく、ぼんやり光る円で出す', () => {
    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 6,
          Accuracy: { Epicenter: 'PLUM 法', Depth: 'PLUM 法', Magnitude: '不明' },
          OriginalText: '37 03 00 ... RK94209 RT01/// RC0//// 9999=',
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const marker = app.el.querySelector('.map__epicenter')!;
    expect(marker.classList.contains('map__epicenter--plum')).toBe(true);
    // 震源を指す×印は出さない
    expect(marker.querySelectorAll('line')).toHaveLength(0);
    // 円は1本だけ。重ねると同心円に見える
    expect(marker.querySelectorAll('circle')).toHaveLength(1);
    expect(marker.querySelector('.map__core')).not.toBeNull();
    // 受信中なので点滅の対象
    expect(marker.classList.contains('map__epicenter--alert')).toBe(true);
    // PLUM法であることを列にも書く
    expect(card().textContent).toContain('PLUM法');
  });

  it('項目の区切りに「/」を使わない', () => {
    const card = app.el.querySelector('.eew')!;
    expect(card.textContent).not.toContain('/');
    // 間隔で分ける。値は別々の要素になっている
    expect(card.querySelectorAll('.eew__scale span').length).toBe(2);
    expect(
      card.querySelectorAll('.eew__report span').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('津波の判定待ちは確定した数字のあとに出す', () => {
    const pending = app.el.querySelector('.eew-overlay .pending')!;
    expect(pending.textContent).toBe('津波 調査中');
    // カードの外。どの地震の判定かは分からないので中には入れない
    expect(pending.closest('.eew')).toBeNull();
    // 主カード（最大予測震度・震源）より後ろ
    const column = [...app.el.querySelector('.eew-overlay')!.children];
    expect(column.indexOf(pending)).toBeGreaterThan(
      column.findIndex((el) => el.classList.contains('eew')),
    );
    // 確定ではないので津波の列は開かない
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
    expect(app.el.textContent).not.toContain('発表はありません');
  });

  it('取消だけになったら判定待ちも消す（地震そのものが無い）', () => {
    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 9, isCancel: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    expect(app.el.querySelector('.pending')).toBeNull();
  });

  it('警報は予報より緊迫して見せる（ハザードストライプ）', () => {
    // 予報のうちはストライプを出さない
    expect(card().querySelector('.eew__hazard')).toBeNull();

    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 9, Title: '緊急地震速報（警報）', isWarn: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    expect(card().classList.contains('eew--warn')).toBe(true);
    // 上端のストライプはカードの先頭
    expect(card().firstElementChild!.className).toBe('eew__hazard');
  });

  it('予報から切り替わると、文字を読まなくても分かる', () => {
    expect(card().classList.contains('eew--warn')).toBe(false);

    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 4,
          Title: '緊急地震速報（警報）',
          isWarn: true,
          MaxIntensity: '6-',
          WarnArea: [
            { Chiiki: '宮崎県北部平野部', Shindo1: '6弱', Shindo2: '6弱' },
            { Chiiki: '大分県南部', Shindo1: '5弱', Shindo2: '5弱' },
          ],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    expect(card().classList.contains('eew--warn')).toBe(true);
    expect(app.el.classList.contains('app--warn')).toBe(true);
    expect(card().textContent).toContain('緊急地震速報（警報）');
    // 同じ地震の続きなので、カードは増えない
    expect(app.el.querySelectorAll('.eew')).toHaveLength(1);
  });

  it('対象地域を震度別にまとめて全件出す', () => {
    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 5,
          isWarn: true,
          WarnArea: [
            { Chiiki: '栃木県南部', Shindo1: '5弱', Shindo2: '5弱' },
            { Chiiki: '茨城県北部', Shindo1: '5弱', Shindo2: '5弱' },
            { Chiiki: '埼玉県南部', Shindo1: '4', Shindo2: '4' },
            { Chiiki: '埼玉県北部', Shindo1: '4', Shindo2: '3' },
          ],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    expect(card().textContent).toContain('強い揺れ 4地域');
    const rows = [...card().querySelectorAll('.eew__area')];
    // 震度別に2行にまとまり、強い順に並ぶ
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.eew__area-grade')!.textContent).toBe('5−');
    // 地名は1つずつ独立した塊。読点でつながない（時刻を添えると紛れる）
    expect(
      [...rows[0]!.querySelectorAll('.eew__area-name')].map((el) => el.textContent),
    ).toEqual(['栃木県南部', '茨城県北部']);
    expect(rows[1]!.querySelector('.eew__area-grade')!.textContent).toBe('4');
    expect(rows[1]!.textContent).toContain('埼玉県南部');
    expect(rows[1]!.textContent).toContain('埼玉県北部');
  });

  it('地域ごとの到達予測時刻は地名と別の要素にし、早い順に並べる', () => {
    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 6,
          isWarn: true,
          AnnouncedTime: '2026/08/16 19:00:10',
          WarnArea: [
            // 気象庁の並び順は地域コード順。到達順ではない
            { Chiiki: '栃木県南部', Shindo1: '5弱', Shindo2: '5弱', Time: '190042' },
            { Chiiki: '茨城県北部', Shindo1: '5弱', Shindo2: '5弱', Time: '190025' },
            {
              Chiiki: '宮崎県北部平野部',
              Shindo1: '5弱',
              Shindo2: '5弱',
              Time: '//////',
              Arrive: '既に到達と推測',
            },
          ],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const row = card().querySelector('.eew__area')!;
    const names = [...row.querySelectorAll('.eew__area-name')];
    // 到達の早い順。時刻が無いものは後ろ
    expect(names.map((el) => el.firstChild!.textContent)).toEqual([
      '茨城県北部',
      '栃木県南部',
      '宮崎県北部平野部',
    ]);
    // 時刻は地名とは別の要素（文字列に足すと地名の一部に見える）
    expect(names[0]!.querySelector('.eew__area-at')!.textContent).toBe('19:00:25');
    expect(names[2]!.querySelector('.eew__area-at')!.textContent).toBe('到達済み');
  });

  it('「最終報」は報番号より目立つ印にする', () => {
    // 予報のうちは印が無い（空の枠も出さない）
    expect(card().querySelector('.eew__flags')).toBeNull();

    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 7, isFinal: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const flags = [...card().querySelectorAll('.eew__flag')].map((el) => el.textContent);
    expect(flags).toContain('最終報');
    // 薄い報番号の列には混ぜない
    expect(card().querySelector('.eew__report')!.textContent).not.toContain('最終報');
  });

  it('切り替わったあとに古い報が届いても戻らない', () => {
    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 4, Title: '緊急地震速報（警報）', isWarn: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    store.ingest(parseWolfxMessage({ ...EEW, Serial: 2 }, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(card().classList.contains('eew--warn')).toBe(true);
  });

  it('取消報は震度を出さない', () => {
    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 4, isCancel: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    const text = card().textContent ?? '';
    expect(text).toContain('取消');
    expect(card().querySelector('.eew__intensity-value')).toBeNull();
    // 「最大予測」の名前も付けない（値があるように読める）
    expect(card().querySelector('.eew__label')).toBeNull();
  });

  it('取消では震源名を大きく出さない（通常の報と見分ける）', () => {
    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 5, isCancel: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    expect(card().classList.contains('eew--cancel')).toBe(true);
    expect(card().querySelector('.eew__hypo')).toBeNull();
    // 消すのではなく、小さい欄に移す
    expect(card().querySelector('.eew__scale')!.textContent).toContain('日向灘');
  });

  it('震源が低精度なら位置を信用させない印を出す', () => {
    store.ingest(
      parseWolfxMessage(
        { ...EEW, Serial: 5, isAssumption: true },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    expect(card().textContent).toContain('震源低精度');
  });
});

describe('連続するEEW', () => {
  const other = {
    ...EEW,
    EventID: '20260816190500',
    Serial: 1,
    AnnouncedTime: '2026/08/16 19:00:03',
    Hypocenter: '茨城県沖',
    MaxIntensity: '3',
  };

  it('別の地震のEEWは縦に積む（地図と一覧は上下に動かない）', () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    store.ingest(parseWolfxMessage(other, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    const cards = [...app.el.querySelectorAll('.eew')];
    expect(cards).toHaveLength(2);
    // 新しいほうが上
    expect(cards[0]!.textContent).toContain('茨城県沖');
    expect(cards[1]!.textContent).toContain('日向灘');
    // 2件目以降は控えめにする
    expect(cards[1]!.classList.contains('eew--secondary')).toBe(true);
  });

  it('最終報から2分で引っ込む', () => {
    store.ingest(
      parseWolfxMessage({ ...EEW, isFinal: true }, { receivedAt: NOW, now: NOW }),
    );
    // 発表は 19:00:00。最終報から2分以内は出る
    expect(store.snapshot(NOW + 60_000).activeEews).toHaveLength(1);
    expect(store.snapshot(NOW + 130_000).activeEews).toHaveLength(0);
  });

  it('最終報が来ていなければ3分待つ（連続報が途中で消えない）', () => {
    store.ingest(
      parseWolfxMessage({ ...EEW, isFinal: false }, { receivedAt: NOW, now: NOW }),
    );
    expect(store.snapshot(NOW + 130_000).activeEews).toHaveLength(1);
    expect(store.snapshot(NOW + 190_000).activeEews).toHaveLength(0);
  });
});

describe('名称の禁止事項', () => {
  it('気象庁のTitleが無いとき、自作の表記に「速報」「警報」「注意報」を使わない', () => {
    // P2Pの556はTitleを持たない。ここでアプリが名前を作ると規約に触れる
    store.ingest(
      parseP2pMessage(
        {
          code: 556,
          id: 'x',
          time: '2026/08/16 19:00:01.000',
          cancelled: false,
          issue: { eventId: 'E1', serial: '1', time: '2026/08/16 19:00:00' },
          earthquake: {
            originTime: '2026/08/16 18:59:50',
            hypocenter: { depth: 10, latitude: 32, longitude: 132, magnitude: 5, name: '日向灘' },
          },
          areas: [{ name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 45 }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    const text = app.el.querySelector('.eew')?.textContent ?? '';
    for (const word of ['緊急地震速報', '警報', '注意報', '震度速報']) {
      expect(text, word).not.toContain(word);
    }
  });

  it('平常時の画面にも禁止語を出さない', () => {
    app.render(makeInput(store));
    for (const word of ['緊急地震速報', '警報', '注意報']) {
      expect(text(), word).not.toContain(word);
    }
  });
});

describe('フェイルサイレント禁止', () => {
  /** 設定を開く（接続の詳細はこの中にある） */
  const openSettings = () => {
    (app.el.querySelector('.compact') as HTMLButtonElement).click();
  };

  it('平常時は点だけ。異常の文字は出さない', () => {
    app.render(makeInput(store));
    const compact = app.el.querySelector('.compact') as HTMLElement;
    expect(compact.classList.contains('compact--bad')).toBe(false);
    expect(compact.querySelector('.compact__text')!.textContent).toBe('');
  });

  it('接続が落ちたら、設定を開かなくても画面に出る', () => {
    const connections = new Map<SourceId, ConnectionState>([
      ['wolfx', { ...connection('wolfx', 'stale'), detail: '90秒無音' }],
      ['p2p', connection('p2p', 'reconnecting')],
    ]);
    app.render(makeInput(store, { connections }));
    const compact = app.el.querySelector('.compact') as HTMLElement;
    expect(compact.classList.contains('compact--bad')).toBe(true);
    expect(compact.textContent).toContain('wolfx 無音');
    expect(compact.textContent).toContain('p2p 再接続待ち');
  });

  it('設定に wolfx / p2p の詳細を出す', () => {
    app.render(makeInput(store));
    openSettings();
    const settings = app.el.querySelector('.settings') as HTMLElement;
    expect(settings.hidden).toBe(false);
    // 素のHTML（箇条書き）で出す
    const inds = [...settings.querySelectorAll('li')].map((el) => el.textContent ?? '');
    expect(inds.some((t) => t.includes('wolfx 受信中'))).toBe(true);
    expect(inds.some((t) => t.includes('p2p 受信中'))).toBe(true);
    // 接続先も設定から確認できる
    expect(settings.textContent).toContain('wss://example.test/ws');
    expect(settings.textContent).toContain('production');
  });

  it('設定は既定で閉じている', () => {
    app.render(makeInput(store));
    expect((app.el.querySelector('.settings') as HTMLElement).hidden).toBe(true);
  });

  it('無音・再接続待ちを設定の中でも区別して出す', () => {
    const connections = new Map<SourceId, ConnectionState>([
      ['wolfx', { ...connection('wolfx', 'stale'), detail: '90秒無音' }],
      ['p2p', connection('p2p', 'reconnecting')],
    ]);
    app.render(makeInput(store, { connections }));
    openSettings();
    const settings = app.el.querySelector('.settings')!;
    // 色ではなく文字で言う（設定画面は素のHTML）
    expect(settings.textContent).toContain('90秒無音');
    expect(settings.textContent).toContain('wolfx 無音');
    expect(settings.textContent).toContain('p2p 再接続待ち');
  });

  it('時刻オフセットが未推定ならそう書く', () => {
    app.render(
      makeInput(store, { clock: { status: 'unknown', offsetMs: null, samples: 0 } }),
    );
    openSettings();
    expect(app.el.querySelector('.settings')!.textContent).toContain('未推定');
  });

  it('時刻オフセットが異常値なら、設定を開かなくても分かる', () => {
    app.render(
      makeInput(store, { clock: { status: 'suspect', offsetMs: 300_000, samples: 5 } }),
    );
    expect(app.el.querySelector('.compact')!.textContent).toContain('時刻ずれ異常');
    openSettings();
    const settings = app.el.querySelector('.settings')!;
    expect(settings.textContent).toContain('異常');
    expect(settings.querySelector('.settings__value--warn')).not.toBeNull();
  });

  it('degraded の理由を常時見えるところに出す', () => {
    app.render(
      makeInput(store, {
        degradedReasons: ['起動時の履歴を取得できず（接続後の受信分のみ表示）'],
      }),
    );
    const compact = app.el.querySelector('.compact') as HTMLElement;
    expect(compact.textContent).toContain('起動時の履歴を取得できず');
    expect(compact.classList.contains('compact--bad')).toBe(true);
  });

  it('解析失敗の件数を出す', () => {
    store.ingest(parseP2pMessage('{壊れている', { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelector('.compact')!.textContent).toContain('解析失敗1');
  });
});

describe('地図の描画', () => {
  it('区域別の震度は地図に打たない（代表点を作らない）', () => {
    const prompt = history.find(
      (r) => (r['issue'] as { type: string }).type === 'ScalePrompt',
    )!;
    store.ingest(parseP2pMessage(prompt, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelectorAll('.map__points circle')).toHaveLength(0);
    // 震度そのものは詳細の一覧に出ている
    expect(app.el.querySelector('.panel--detail')!.textContent).toContain('区域別');
  });

  it('観測点別の震度は点で打つ', () => {
    const detail = history.find(
      (r) =>
        (r['issue'] as { type: string }).type === 'DetailScale' &&
        (r['points'] as unknown[]).length > 3,
    )!;
    store.ingest(parseP2pMessage(detail, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelectorAll('.map__points circle').length).toBeGreaterThan(0);
  });

  it('観測点が数百を超えたらCanvasに切り替える', () => {
    for (const raw of quake) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    const canvas = app.el.querySelector('.map__canvas') as HTMLCanvasElement;
    expect(canvas.hidden).toBe(false);
    // DOMには積まない
    expect(app.el.querySelectorAll('.map__points circle')).toHaveLength(0);
  });

  it('範囲外の震源は「範囲外」と書く（遠地地震）', () => {
    const foreign = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Foreign',
    )!;
    store.ingest(parseP2pMessage(foreign, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const outside = app.el.querySelector('.map__outside') as HTMLElement;
    expect(outside.hidden).toBe(false);
    expect(outside.textContent).toContain('範囲外');
  });
});

describe('地図の拡大', () => {
  const viewBox = () =>
    (app.el.querySelector('.map__svg') as SVGSVGElement)
      .getAttribute('viewBox')!
      .split(' ')
      .map(Number);

  it('選択中の地震（起動直後は最新）の揺れが入るところまで寄せる', () => {
    const detail = history.find(
      (r) =>
        (r['issue'] as { type: string }).type === 'DetailScale' &&
        (r['points'] as unknown[]).length > 10,
    )!;
    store.ingest(parseP2pMessage(detail, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const [, , w] = viewBox();
    // 全域（1000）より狭くなっている
    expect(w).toBeLessThan(1000);
    expect(w).toBeGreaterThanOrEqual(130);
    expect(app.el.querySelector('.map')!.classList.contains('map--zoomed')).toBe(true);
  });

  it('一覧で選び直すと、その地震の範囲に寄せ直す', () => {
    for (const raw of history.slice(0, 12)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    const first = viewBox().join(',');

    const rows = [...app.el.querySelectorAll('.row')] as HTMLButtonElement[];
    // 別の地震を選ぶ（震源が違えば範囲も変わる）
    const other = rows.find((r, i) => i > 0 && r.textContent !== rows[0]!.textContent);
    other!.click();
    expect(viewBox().join(',')).not.toBe(first);
  });

  it('「全域」と「揺れの範囲」を行き来できる', () => {
    const detail = history.find(
      (r) =>
        (r['issue'] as { type: string }).type === 'DetailScale' &&
        (r['points'] as unknown[]).length > 10,
    )!;
    store.ingest(parseP2pMessage(detail, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    const button = app.el.querySelector('.map__reset') as HTMLButtonElement;
    const zoomed = viewBox();
    expect(zoomed[2]).toBeLessThan(1000);
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('全域');

    button.click();
    expect(viewBox()).toEqual([0, 0, 1000, 1000]);
    // 戻る先が示されていて、ボタンは消えない
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('揺れの範囲');

    button.click();
    expect(viewBox()).toEqual(zoomed);
    expect(button.textContent).toBe('全域');
  });

  it('全域にしたあと別の地震を選ぶと、その地震に寄せ直す', () => {
    for (const raw of history.slice(0, 12)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    (app.el.querySelector('.map__reset') as HTMLButtonElement).click();
    expect(viewBox()[2]).toBe(1000);

    const rows = [...app.el.querySelectorAll('.row')] as HTMLButtonElement[];
    const other = rows.find((r, i) => i > 0 && r.textContent !== rows[0]!.textContent);
    other!.click();
    expect(viewBox()[2]).toBeLessThan(1000);
    expect((app.el.querySelector('.map__reset') as HTMLElement).textContent).toBe('全域');
  });

  it('寄せる対象が無ければボタンを出さない', () => {
    // 遠地地震は範囲外なので寄せない
    const foreign = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Foreign',
    )!;
    store.ingest(parseP2pMessage(foreign, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect((app.el.querySelector('.map__reset') as HTMLElement).hidden).toBe(true);
  });

  it('震度の情報が無い報（震源だけ）でも震源のまわりを見せる', () => {
    const destination = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Destination',
    )!;
    store.ingest(parseP2pMessage(destination, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(viewBox()[2]).toBeLessThan(1000);
  });

  it('範囲外の遠地地震では全域のままにする（日本が消えない）', () => {
    const foreign = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Foreign',
    )!;
    store.ingest(parseP2pMessage(foreign, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(viewBox()).toEqual([0, 0, 1000, 1000]);
  });

  it('EEW受信中は震源のまわりを切り出す', () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const [x, y, w, hh] = viewBox();
    expect(w).toBe(340);
    expect(hh).toBe(340);
    // 震源（日向灘 32.0N 132.1E）が範囲の中にある
    const p = project(132.1, 32.0);
    expect(p.x).toBeGreaterThanOrEqual(x!);
    expect(p.x).toBeLessThanOrEqual(x! + w!);
    expect(p.y).toBeGreaterThanOrEqual(y!);
    expect(p.y).toBeLessThanOrEqual(y! + hh!);
  });
});

describe('津波が発表されている間のEEW', () => {
  const withTsunami = (grade: string) => ({
    code: 552,
    id: `t-${grade}`,
    time: '2026/08/16 19:05:29.069',
    cancelled: false,
    issue: { source: '気象庁', time: '2026/08/16 19:05:00', type: 'Focus' },
    areas: [
      {
        name: '岩手県',
        grade,
        immediate: true,
        maxHeight: { description: '１０ｍ超', value: 10 },
      },
      { name: '千葉県九十九里・外房', grade: 'Watch', immediate: false },
    ],
  });

  it('あらゆるEEWのカードに「津波情報 発表中」を載せる', () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    store.ingest(
      parseWolfxMessage(
        { ...EEW, EventID: 'AFTERSHOCK', Serial: 1, AnnouncedTime: '2026/08/16 18:59:58' },
        { receivedAt: NOW, now: NOW },
      ),
    );
    store.ingest(
      parseP2pMessage(withTsunami('MajorWarning'), { receivedAt: NOW, now: NOW }),
    );
    app.render(makeInput(store));

    const marks = [...app.el.querySelectorAll('.eew__tsunami')];
    // 余震のカードにも載る
    expect(marks).toHaveLength(2);
    for (const m of marks) {
      expect(m.textContent).toContain('津波情報 発表中');
      // いちばん重い階級を出す（注意報が混ざっていても大津波警報）
      expect(m.textContent).toContain('大津波警報');
      expect(m.classList.contains('eew__tsunami--MajorWarning')).toBe(true);
    }
  });

  it('津波が無い間は載せない', () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelector('.eew__tsunami')).toBeNull();
  });

  it('解除されたら消える', () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    store.ingest(parseP2pMessage(withTsunami('Warning'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelector('.eew__tsunami')).not.toBeNull();

    store.ingest(
      parseP2pMessage(
        {
          code: 552,
          id: 'cancel',
          time: '2026/08/16 19:20:00.000',
          cancelled: true,
          issue: { source: '気象庁', time: '2026/08/16 19:20:00', type: 'Focus' },
          areas: [],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    expect(app.el.querySelector('.eew__tsunami')).toBeNull();
  });
});

describe('津波の判定がまだ出ていないとき', () => {
  const quakeWith = (domesticTsunami: string, id: string) => ({
    code: 551,
    id,
    time: '2026/08/16 19:00:10.000',
    issue: { type: 'DetailScale', time: '2026/08/16 19:00:10' },
    earthquake: {
      time: '2026/08/16 19:00:00',
      maxScale: 40,
      domesticTsunami,
      hypocenter: {
        name: '茨城県沖',
        latitude: 36.5,
        longitude: 141,
        depth: 40,
        magnitude: 5.5,
      },
    },
    points: [{ addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 40 }],
  });

  it('EEWが無くても、551が調査中なら列を開いて出す', () => {
    // 552（確定）より先に届くのがこれ。EEWが出ない規模でも来る
    store.ingest(parseP2pMessage(quakeWith('Checking', 'q1'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), NOW);

    const pending = app.el.querySelector('.eew-overlay .pending')!;
    expect(pending.textContent).toBe('津波 調査中');
    expect(app.el.classList.contains('app--eew')).toBe(true);
    // EEWのカードは無い
    expect(app.el.querySelector('.eew')).toBeNull();
    // 確定ではないので津波の列は開かない
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
    expect(app.el.querySelector('.panel--tsunami')).toBeNull();
  });

  it('時間が経っていることを隠さない（勝手に消さない）', () => {
    store.ingest(parseP2pMessage(quakeWith('Checking', 'q4'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), NOW + 8 * 60_000);
    expect(app.el.querySelector('.pending')!.textContent).toContain('8分経過');
  });

  it('津波なしと分かれば出さない', () => {
    store.ingest(parseP2pMessage(quakeWith('None', 'q2'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), NOW);
    expect(app.el.querySelector('.pending')).toBeNull();
    expect(app.el.classList.contains('app--eew')).toBe(false);
  });

  it('確定情報が来たら調査中の表示は消え、列が開く', () => {
    store.ingest(parseP2pMessage(quakeWith('Checking', 'q3'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), NOW);
    expect(app.el.querySelector('.pending')).not.toBeNull();

    store.ingest(
      parseP2pMessage(
        {
          code: 552,
          id: 't1',
          time: '2026/08/16 19:02:00.000',
          cancelled: false,
          issue: { source: '気象庁', time: '2026/08/16 19:02:00', type: 'Focus' },
          areas: [{ name: '茨城県', grade: 'Watch', immediate: false, maxHeight: { description: '１ｍ' } }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store), NOW);

    expect(app.el.querySelector('.pending')).toBeNull();
    expect(app.el.classList.contains('app--tsunami')).toBe(true);
    expect(app.el.querySelector('.main__tsunami')!.textContent).toContain('茨城県');
  });

  it('古い地震の調査中を引きずらない（最新の地震だけを見る）', () => {
    store.ingest(parseP2pMessage(quakeWith('Checking', 'old'), { receivedAt: NOW, now: NOW }));
    const newer = {
      ...quakeWith('None', 'new'),
      time: '2026/08/16 19:10:10.000',
      issue: { type: 'DetailScale', time: '2026/08/16 19:10:10' },
      earthquake: {
        ...quakeWith('None', 'new').earthquake,
        time: '2026/08/16 19:10:00',
      },
    };
    store.ingest(parseP2pMessage(newer, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), NOW);
    expect(app.el.querySelector('.pending')).toBeNull();
  });
});

describe('津波の発表を受けている間', () => {
  const tsunami = (areas: unknown[], cancelled = false) => ({
    code: 552,
    id: `t-${areas.length}-${cancelled}`,
    time: '2026/08/16 19:05:29.069',
    cancelled,
    issue: { source: '気象庁', time: '2026/08/16 19:05:00', type: 'Focus' },
    areas,
  });

  const WATCH = {
    name: '千葉県九十九里・外房',
    grade: 'Watch',
    immediate: true,
    firstHeight: { condition: '津波到達中と推測' },
    maxHeight: { description: '１ｍ', value: 1 },
  };
  const MAJOR = {
    name: '岩手県',
    grade: 'MajorWarning',
    immediate: false,
    maxHeight: { description: '１０ｍ超', value: 10 },
  };

  it('地震情報の隣の列に出す（一覧の上に畳まない）', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    expect(app.el.classList.contains('app--tsunami')).toBe(true);
    const column = app.el.querySelector('.main__tsunami')!;
    expect(column.querySelector('.panel--tsunami')).not.toBeNull();
    // 一覧の側にはもう無い
    expect(app.el.querySelector('.main__side .panel--tsunami')).toBeNull();
    expect(column.textContent).toContain('千葉県九十九里・外房');
  });

  it('列の最上部に、いちばん重い階級の呼びかけを出す', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH, MAJOR]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    const column = app.el.querySelector('.main__tsunami')!;
    const action = column.querySelector('.tsunami__action')!;
    // 先頭に出る
    expect(column.querySelector('.panel__body')!.firstElementChild).toBe(action);
    // 大津波警報と津波注意報が混在していれば、重いほうに従う
    expect(action.textContent).toContain('いますぐ高台へ避難');
    expect(action.classList.contains('tsunami__action--MajorWarning')).toBe(true);
  });

  it('注意報だけなら呼びかけも注意報のもの', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const action = app.el.querySelector('.tsunami__action')!;
    expect(action.textContent).toContain('いますぐ海から上がる');
    expect(action.classList.contains('tsunami__action--Watch')).toBe(true);
  });

  it('過去の発表では呼びかけを出さない（再生・接続直後の古い報）', () => {
    // 配信時刻が3分より前 → historical
    const old = { ...tsunami([MAJOR]), id: 'old', time: '2026/08/16 18:00:00.000' };
    store.ingest(parseP2pMessage(old, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    // 区域の一覧は出るが、避難の呼びかけは出さない
    expect(app.el.querySelector('.main__tsunami')!.textContent).toContain('岩手県');
    expect(app.el.querySelector('.tsunami__action')).toBeNull();
  });

  it('階級はコードではなく気象庁の呼称で出し、重い順に並べる', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH, MAJOR]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const grades = [...app.el.querySelectorAll('.tsunami__grade')].map(
      (el) => el.textContent,
    );
    expect(grades).toEqual(['大津波警報', '津波注意報']);
    // 生のコードは出さない
    expect(app.el.querySelector('.main__tsunami')!.textContent).not.toContain(
      'MajorWarning',
    );
  });

  it('高さと到達がいちばん大きい', () => {
    store.ingest(
      parseP2pMessage(
        // 実データと同じ生の形（maxHeight.description / firstHeight.arrivalTime）
        tsunami([
          {
            name: '岩手県',
            grade: 'MajorWarning',
            immediate: false,
            maxHeight: { description: '１０ｍ超', value: 10 },
            firstHeight: { arrivalTime: '2026/08/16 19:40:00' },
          },
        ]),
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    const row = app.el.querySelector('.tsunami__area')!;
    expect(row.querySelector('.tsunami__height')!.textContent).toBe('１０ｍ超');
    // 到達予想時刻（firstHeight.arrivalTime）が時刻として出る
    expect(row.querySelector('.tsunami__arrival')!.textContent).toMatch(
      /^\d{2}:\d{2}:\d{2}$/,
    );
    // 階級ごとに背景を塗り分ける
    expect(row.classList.contains('tsunami__area--MajorWarning')).toBe(true);
  });

  it('到達中・直ちに来襲は時刻より優先して出す', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelector('.tsunami__arrival')!.textContent).toBe('直ちに来襲');
  });

  it('解除されたら列ごと消える（右側に残さない）', () => {
    store.ingest(parseP2pMessage(tsunami([WATCH]), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.classList.contains('app--tsunami')).toBe(true);

    store.ingest(
      parseP2pMessage(
        { ...tsunami([], true), id: 'cancel', issue: { time: '2026/08/16 19:20:00' } },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
    expect(app.el.querySelector('.panel--tsunami')).toBeNull();
    expect(app.el.querySelector('.main__tsunami')!.children).toHaveLength(0);
  });

  it('発表が無いときは列を開かない', () => {
    app.render(makeInput(store));
    expect(app.el.classList.contains('app--tsunami')).toBe(false);
    expect(app.el.querySelector('.main__side .panel--tsunami')).toBeNull();
  });
});

describe('地図の点に出す震度', () => {
  const zoomedQuake = () =>
    history.find(
      (r) =>
        (r['issue'] as { type: string }).type === 'DetailScale' &&
        (r['points'] as unknown[]).length > 10,
    )!;

  it('続報で震度が訂正されたら、点の数が同じでも描き直す', () => {
    /*
     * 続報で観測点の数が変わらないまま、震度だけが訂正されることがある。
     * このとき地図が古い色のまま残ると、黙って古い値を見せることになる。
     *
     * **最大震度は動かさない**。最大が変わると点の並び順（強い順）で
     * 先頭が入れ替わるので、件数と先頭だけ見る指紋でも気付けてしまい、
     * 取りこぼしの検査にならない。
     */
    const report = (scale: number, issuedAt: string) => ({
      code: 551,
      id: `fix-${scale}`,
      time: `2026/08/16 ${issuedAt}.000`,
      issue: { type: 'DetailScale', time: `2026/08/16 ${issuedAt}` },
      earthquake: {
        time: '2026/08/16 19:00:00',
        maxScale: 40,
        hypocenter: {
          name: '茨城県沖',
          latitude: 36.5,
          longitude: 141,
          depth: 40,
          magnitude: 5.5,
        },
      },
      points: [
        { addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 40 },
        { addr: '宇都宮市明保野町', pref: '栃木県', isArea: false, scale },
        { addr: '前橋市昭和町', pref: '群馬県', isArea: false, scale: 10 },
      ],
    });

    const fills = () =>
      [...app.el.querySelectorAll('.map__points circle')].map((c) =>
        c.getAttribute('fill'),
      );

    store.ingest(parseP2pMessage(report(20, '19:00:10'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const before = fills();

    // 震度2だった観測点が、訂正報で震度3になった（最大の40は動かない）
    store.ingest(parseP2pMessage(report(30, '19:00:40'), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));

    const after = fills();
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before);
  });

  it('十分に寄ったら点の中に震度を出す', () => {
    store.ingest(parseP2pMessage(zoomedQuake(), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    const labels = [...app.el.querySelectorAll('.map__points text')];
    expect(labels.length).toBeGreaterThan(0);
    // 数字と符号に分けて組む（漢字は混ぜない）
    for (const l of labels) expect(l.textContent).toMatch(/^[1-7][−+]?$/);
  });

  it('数字も符号も斜体、符号は小さく少し上に置く', () => {
    store.ingest(
      parseP2pMessage(
        {
          code: 551,
          id: 'weak5',
          time: '2026/08/16 19:00:10.000',
          issue: { type: 'DetailScale', time: '2026/08/16 19:00:10' },
          earthquake: {
            time: '2026/08/16 19:00:00',
            maxScale: 45,
            hypocenter: {
              name: '茨城県沖',
              latitude: 36.5,
              longitude: 141,
              depth: 40,
              magnitude: 5.5,
            },
          },
          points: [{ addr: '水戸市金町', pref: '茨城県', isArea: false, scale: 45 }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    const text = app.el.querySelector('.map__points text')!;
    const spans = [...text.querySelectorAll('tspan')];
    expect(spans.map((t) => t.textContent)).toEqual(['5', '−']);
    // 斜体は数字ごとまとめてかける（クラス側で指定）
    expect(text.classList.contains('map__label')).toBe(true);
    const mod = spans[1]!;
    // 符号は数字より小さく、上にずらす
    expect(Number(mod.getAttribute('font-size'))).toBeLessThan(
      Number(text.getAttribute('font-size')),
    );
    expect(Number(mod.getAttribute('dy'))).toBeLessThan(0);
  });

  it('全域に戻したら数字は出さない（潰れて読めないため）', () => {
    store.ingest(parseP2pMessage(zoomedQuake(), { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    (app.el.querySelector('.map__reset') as HTMLButtonElement).click();
    expect(app.el.querySelectorAll('.map__points text')).toHaveLength(0);
    expect(app.el.querySelectorAll('.map__points circle').length).toBeGreaterThan(0);
  });
});

describe('設定した地点の推定震度', () => {
  const observer = {
    lat: 32.2,
    lon: 131.6,
    label: null,
    savedAt: NOW,
    avs30: 300,
    jname: '谷底低地',
  };

  const withEew = () => {
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
  };

  it('未設定なら何も出さない', () => {
    withEew();
    expect((app.el.querySelector('.estimate') as HTMLElement).hidden).toBe(true);
  });

  /** 走時表を読み込んだ状態にする */
  const withTable = () => {
    app.setTravelTimeTable(
      parseTravelTimeTable(
        readFileSync(`${process.cwd()}/public/assets/tjma2001.txt`, 'utf8'),
      ),
    );
  };

  it('走時表があれば主要動のカウントダウンを出す', () => {
    withTable();
    app.setObserver(observer);
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    // 発震（18:59:50）から5秒。宮崎の地点にはまだ主要動が来ていない
    app.render(makeInput(store), NOW - 10_000);

    const arrival = app.el.querySelector('.estimate__arrival')!;
    // 0.1秒まで出す。整数部と小数部は別の要素（大きさを変えて組む）
    expect(arrival.querySelector('.estimate__countdown-sec')!.textContent).toMatch(
      /^\d+$/,
    );
    expect(arrival.querySelector('.estimate__countdown-frac')!.textContent).toMatch(
      /^\.\d$/,
    );
    expect(arrival.querySelector('.estimate__countdown')!.textContent).toMatch(
      /^\d+\.\d秒$/,
    );
    // 何のカウントダウンかは見出しで言う（P波の秒数は持たない）
    expect(arrival.querySelector('.estimate__arrival-label')!.textContent).toBe(
      '主要動到達まで',
    );
    // 震度より先に読む位置（枠の中で震度の行より前）
    const children = [...app.el.querySelector('.estimate')!.children].map(
      (el) => el.className.split(' ')[0],
    );
    expect(children.indexOf('estimate__arrival')).toBeLessThan(
      children.indexOf('estimate__row'),
    );
  });

  it('過ぎても見出しは消さない（枠の高さを動かさない）', () => {
    withTable();
    app.setObserver(observer);
    store.ingest(parseWolfxMessage(EEW, { receivedAt: NOW, now: NOW }));
    // 発震から1分後。とうに過ぎている
    app.render(makeInput(store), NOW + 60_000);

    const arrival = app.el.querySelector('.estimate__arrival')!;
    expect(arrival.classList.contains('estimate__arrival--passed')).toBe(true);
    // 見出しは残り、数字は0.0で止まる
    expect(arrival.textContent).toBe('主要動到達まで0.0秒');
    expect(arrival.querySelector('.estimate__countdown')!.textContent).toBe('0.0秒');
  });

  it('走時表が無ければカウントダウンを出さない（0秒と書かない）', () => {
    app.setTravelTimeTable(null);
    app.setObserver(observer);
    withEew();
    expect(app.el.querySelector('.estimate__arrival')).toBeNull();
  });

  it('設定してあれば、その地点の推定震度を出す', () => {
    app.setObserver(observer);
    withEew();

    const el = app.el.querySelector('.estimate') as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.estimate__value')!.textContent).toMatch(/^[0-7][−+]?$/);
    expect(el.textContent).toContain('計測震度');
    expect(el.textContent).toContain('震央から');
  });

  it('常時同じ注意書きは出さない（値と状態だけ）', () => {
    app.setObserver(observer);
    withEew();
    const text = app.el.querySelector('.estimate')!.textContent ?? '';
    for (const noise of ['自前の計算', '±1階級', '精度外', '過大']) {
      expect(text, noise).not.toContain(noise);
    }
  });

  it('地図の下中央（HUD）に置く。カードの中には入れない', () => {
    app.setObserver(observer);
    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 8,
          isWarn: true,
          WarnArea: [{ Chiiki: '宮崎県北部平野部', Shindo1: '5弱', Shindo2: '5弱' }],
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const card = app.el.querySelector('.eew')!;
    const inCard = [...card.children].map((el) => el.className.split(' ')[0]);
    expect(inCard).toEqual([
      // 警報なのでハザードストライプが先頭に付く（CSSで左端の縦帯になる）
      'eew__hazard',
      'eew__head',
      'eew__title',
      'eew__hypo',
      'eew__scale',
      'eew__report',
      'eew__area-title',
      'eew__areas',
    ]);

    // この地点はHUDの中。カードの中には無い
    const estimate = app.el.querySelector('.estimate') as HTMLElement;
    expect(estimate.hidden).toBe(false);
    expect(estimate.closest('.hud')).not.toBeNull();
    expect(estimate.closest('.eew')).toBeNull();
    // HUDは地図の上に重なる（列にしない。地図の幅を変えない）
    expect(estimate.closest('.main__map')).not.toBeNull();
    expect(estimate.querySelector('.estimate__title')!.textContent).toBe('この地点');
  });

  it('列全体の並びは 主カード → 判定待ち → 余震', () => {
    app.setObserver(observer);
    withEew();
    store.ingest(
      parseWolfxMessage(
        { ...EEW, EventID: 'AFTERSHOCK', Serial: 1, AnnouncedTime: '2026/08/16 18:59:58' },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));

    const column = [...app.el.querySelector('.eew-overlay')!.children].map((el) =>
      el.className.split(' ').slice(0, 2).join(' '),
    );
    expect(column).toEqual(['eew', 'pending', 'eew eew--secondary']);
  });

  it('地盤データが無ければ計算せず、理由を書く', () => {
    app.setObserver({ ...observer, avs30: null });
    withEew();
    const el = app.el.querySelector('.estimate')!;
    expect(el.querySelector('.estimate__value')).toBeNull();
    expect(el.textContent).toContain('地盤データ');
  });

  it('PLUM法では計算せず、理由を書く', () => {
    app.setObserver(observer);
    store.ingest(
      parseWolfxMessage(
        {
          ...EEW,
          Serial: 7,
          Accuracy: { Epicenter: 'PLUM 法', Depth: '', Magnitude: '' },
          OriginalText: '37 03 00 ... RK94209 RT01/// 9999=',
        },
        { receivedAt: NOW, now: NOW },
      ),
    );
    app.render(makeInput(store));
    expect(app.el.querySelector('.estimate')!.textContent).toContain('PLUM法');
  });

  it('EEWが無いときは出さない', () => {
    app.setObserver(observer);
    app.render(makeInput(store));
    expect((app.el.querySelector('.estimate') as HTMLElement).hidden).toBe(true);
  });
});

describe('設定ボタンと動作確認', () => {
  it('右上の設定ボタンから開ける', () => {
    const runs: string[] = [];
    const withScenarios = new App({
      endpoint: 'wss://example.test/ws',
      environment: 'production',
      scenarios: [{ id: 's1', label: '津波 Watch 3区域', run: () => runs.push('s1') }],
      onClear: () => runs.push('clear'),
    });
    withScenarios.render(makeInput(store));

    const button = withScenarios.el.querySelector('.settings-button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect((withScenarios.el.querySelector('.settings') as HTMLElement).hidden).toBe(true);

    button.click();
    expect((withScenarios.el.querySelector('.settings') as HTMLElement).hidden).toBe(false);
    expect(button.classList.contains('settings-button--open')).toBe(true);

    // 動作確認の項目が並んでいる
    const scenarioButtons = [
      ...withScenarios.el.querySelectorAll('.settings__btn'),
    ] as HTMLButtonElement[];
    expect(scenarioButtons.map((b) => b.textContent)).toContain('津波 Watch 3区域');

    scenarioButtons[0]!.click();
    expect(runs).toEqual(['s1']);

    scenarioButtons[scenarioButtons.length - 1]!.click();
    expect(runs).toEqual(['s1', 'clear']);
  });

  it('シナリオを渡さなければ動作確認の節を出さない', () => {
    app.render(makeInput(store));
    (app.el.querySelector('.settings-button') as HTMLButtonElement).click();
    expect(app.el.querySelector('.settings__btn')).toBeNull();
  });

  it('投入中は帯にその旨を出す（本物と取り違えないため）', () => {
    app.render(makeInput(store));
    app.setTestLabel('津波 MajorWarning 7区域');
    const compact = app.el.querySelector('.compact') as HTMLElement;
    expect(compact.textContent).toContain('テスト投入中');
    expect(compact.textContent).toContain('津波 MajorWarning 7区域');
    expect(app.el.classList.contains('app--test')).toBe(true);

    app.setTestLabel(null);
    expect(app.el.querySelector('.compact')!.textContent).not.toContain('テスト投入中');
    expect(app.el.classList.contains('app--test')).toBe(false);
  });
});

describe('詳細の表示切り替えと時計', () => {
  const detail = () => app.el.querySelector('.panel--detail') as HTMLElement;

  it('既定では詳細を出さず、その位置に時計を出す', () => {
    app.render(makeInput(store), Date.parse('2026-08-16T10:02:47Z'));

    expect(detail().hidden).toBe(true);
    const clock = app.el.querySelector('.main__side .clock')!;
    expect(clock.querySelector('.clock__time')!.textContent).toBe('19:02:47');
    // JSTであることを明記する
    expect(clock.querySelector('.clock__zone')!.textContent).toBe('JST');
    expect(clock.querySelector('.clock__date')!.textContent).toBe('08/16');
  });

  it('時計は補正済みの時刻で毎回書き換わる', () => {
    app.render(makeInput(store), Date.parse('2026-08-16T10:02:47Z'));
    app.render(makeInput(store), Date.parse('2026-08-16T10:02:48Z'));
    expect(app.el.querySelector('.clock__time')!.textContent).toBe('19:02:48');
  });

  it('設定から詳細を出せる', () => {
    const changes: boolean[] = [];
    const withDetail = new App({
      endpoint: 'wss://example.test/ws',
      environment: 'production',
      detail: { enabled: false, onChange: (on) => changes.push(on) },
    });
    withDetail.render(makeInput(store));
    expect((withDetail.el.querySelector('.panel--detail') as HTMLElement).hidden).toBe(
      true,
    );

    (withDetail.el.querySelector('.settings-button') as HTMLButtonElement).click();
    const check = withDetail.el.querySelector('.settings__check') as HTMLInputElement;
    check.checked = true;
    check.dispatchEvent(new Event('change'));

    expect(changes).toEqual([true]);
    expect((withDetail.el.querySelector('.panel--detail') as HTMLElement).hidden).toBe(
      false,
    );
    // 時計は出したまま
    expect(withDetail.el.querySelector('.clock')).not.toBeNull();
  });

  it('折りたたみは持たない（出すか出さないかだけ）', () => {
    const withDetail = new App({
      endpoint: 'wss://example.test/ws',
      environment: 'production',
      detail: { enabled: true, onChange: () => {} },
    });
    for (const raw of history.slice(0, 4)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    withDetail.render(makeInput(store));

    const panel = withDetail.el.querySelector('.panel--detail')!;
    expect(panel.querySelector('.panel__title--toggle')).toBeNull();
    expect(panel.querySelector('.panel__caret')).toBeNull();
    // 出しているときは中身がそのまま見える
    expect((panel.querySelector('.panel__body') as HTMLElement).hidden).toBe(false);
    expect(panel.querySelectorAll('.chip').length).toBeGreaterThan(0);
  });

  it('設定を覚えていれば起動時から出す', () => {
    const withDetail = new App({
      endpoint: 'wss://example.test/ws',
      environment: 'production',
      detail: { enabled: true, onChange: () => {} },
    });
    withDetail.render(makeInput(store));
    expect((withDetail.el.querySelector('.panel--detail') as HTMLElement).hidden).toBe(
      false,
    );
  });
});

describe('詳細', () => {
  it('発表種別を日本語で書く（生のコードを出さない）', () => {
    for (const raw of history.slice(0, 20)) {
      store.ingest(parseP2pMessage(raw, { receivedAt: NOW, now: NOW }));
    }
    app.render(makeInput(store));
    const detail = app.el.querySelector('.panel--detail')!.textContent ?? '';
    for (const code of ['ScalePrompt', 'Destination', 'DetailScale', 'Foreign']) {
      expect(detail, code).not.toContain(code);
    }
    expect(detail).toMatch(/各地の震度|震源に関する情報|震度の第一報|遠地地震/);
    expect(detail).toContain('報）');
  });

  it('震度のない報（震源だけ）を正しく書く', () => {
    const destination = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Destination',
    )!;
    store.ingest(parseP2pMessage(destination, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(app.el.querySelector('.panel--detail')!.textContent).toContain(
      '震度の情報はありません',
    );
  });

  it('不明な値は空欄にせず「不明」と書く', () => {
    const foreign = history.find(
      (r) => (r['issue'] as { type: string }).type === 'Foreign',
    )!;
    store.ingest(parseP2pMessage(foreign, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store));
    expect(text()).toContain('深さ不明');
    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain('Infinity');
    expect(text()).not.toContain('undefined');
  });
});

/**
 * 報が更新されると震源も規模も動く。第1報の値を持ち続けると、
 * 画面の数字だけが古いまま残る（いちばん静かに嘘をつく壊れ方）。
 */
describe('報が更新されたときの再計算', () => {
  const observer = {
    lat: 32.2,
    lon: 131.6,
    label: null,
    savedAt: NOW,
    avs30: 300,
    jname: '谷底低地',
  };

  /** 発震（18:59:50）から5秒の時点で描く。到達予測が進行中になる */
  const AT = NOW - 10_000;

  const setup = () => {
    app.setTravelTimeTable(
      parseTravelTimeTable(
        readFileSync(`${process.cwd()}/public/assets/tjma2001.txt`, 'utf8'),
      ),
    );
    app.setObserver(observer);
  };

  const send = (patch: Record<string, unknown>) => {
    store.ingest(parseWolfxMessage({ ...EEW, ...patch }, { receivedAt: NOW, now: NOW }));
    app.render(makeInput(store), AT);
  };

  /** 主要動までの残り秒数 */
  const remain = () =>
    Number(app.el.querySelector('.estimate__countdown-sec')!.textContent);
  /** 震央距離 */
  const distance = () => {
    const m = /震央から(\d+)km/.exec(app.el.querySelector('.estimate')!.textContent ?? '');
    return Number(m![1]);
  };
  const measured = () => {
    const m = /計測震度 ([\d.]+)/.exec(app.el.querySelector('.estimate')!.textContent ?? '');
    return Number(m![1]);
  };

  it('深さが変わると、到達予測も予測震度も引き直す', () => {
    setup();
    send({ Serial: 3, Depth: 30 });
    const shallow = { remain: remain(), measured: measured() };
    expect(app.el.querySelector('.eew__scale')!.textContent).toContain('深さ30km');

    // 第4報で深くなった
    send({ Serial: 4, Depth: 90 });
    expect(app.el.querySelector('.eew__scale')!.textContent).toContain('深さ90km');
    // 深いぶん到達は遅く、揺れは小さくなる
    expect(remain()).toBeGreaterThan(shallow.remain);
    expect(measured()).toBeLessThan(shallow.measured);
  });

  it('震源の位置が変わると、震央距離も到達予測も引き直す', () => {
    setup();
    send({ Serial: 3 });
    const near = { remain: remain(), distance: distance() };

    // 第5報で震源が南に飛んだ
    send({ Serial: 5, Latitude: 30.5, Longitude: 132.1 });
    expect(distance()).toBeGreaterThan(near.distance + 100);
    expect(remain()).toBeGreaterThan(near.remain);
  });

  it('規模が変わると予測震度を引き直す（到達予測は変わらない）', () => {
    setup();
    send({ Serial: 3, Magunitude: 5.8 });
    const before = { remain: remain(), measured: measured() };

    send({ Serial: 6, Magunitude: 7.2 });
    expect(measured()).toBeGreaterThan(before.measured);
    // 走時は規模に依らない
    expect(remain()).toBe(before.remain);
  });

  it('最大予測震度も報ごとに差し替わる', () => {
    setup();
    send({ Serial: 3, MaxIntensity: '4' });
    expect(app.el.querySelector('.eew__intensity-value')!.textContent).toBe('4');

    send({ Serial: 7, MaxIntensity: '6+' });
    expect(app.el.querySelector('.eew__intensity-value')!.textContent).toBe('6+');
  });

  it('古い報が遅れて届いても巻き戻さない', () => {
    setup();
    send({ Serial: 5, Depth: 90 });
    const after = { remain: remain(), measured: measured() };

    // 第2報が遅れて到着（第5報より古い）
    send({ Serial: 2, Depth: 10 });
    expect(app.el.querySelector('.eew__scale')!.textContent).toContain('深さ90km');
    expect(remain()).toBe(after.remain);
    expect(measured()).toBe(after.measured);
  });

  it('報が来なくても、秒が進めば残り時間は減る', () => {
    setup();
    send({ Serial: 3 });
    const before = remain();

    // 同じ報のまま3秒進める（1秒ごとの再描画で起きること）
    app.render(makeInput(store), AT + 3_000);
    expect(remain()).toBe(before - 3);
  });

  it('取消を受けたら、この地点の枠ごと下げる', () => {
    setup();
    send({ Serial: 3 });
    expect(app.el.querySelector('.estimate')).not.toBeNull();

    send({ Serial: 8, isCancel: true });
    // 無かったことになった揺れの到達予測は出さない
    expect((app.el.querySelector('.estimate') as HTMLElement).hidden).toBe(true);
    expect(app.el.querySelector('.eew')!.textContent).toContain('取消');
  });
});
