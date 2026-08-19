# EEWview

日本の緊急地震速報・地震情報・津波予報を1画面で見る個人用ブラウザアプリ。
予報業務となってしまうのでアクセスできるWebサイトはありません。ダウンロードしてローカルで実行してください。

```sh
npm install
npm run dev      # 開発サーバー
npm test         # Vitest
npm run build    # dist/ に静的ファイル
```

接続先は `.env.local`（`.env.example` を参照）。

## 出典と権利

| 情報・データ | 出典 | 権利 |
|---|---|---|
| 緊急地震速報 | Wolfx `wss://ws-api.wolfx.jp/jma_eew`（気象庁発表の中継） | Wolfxの利用条件による |
| 地震情報・津波予報 | P2P地震情報 API v2 `wss://api.p2pquake.net/v2/ws`（気象庁発表の中継） | P2P地震情報の利用条件による |
| 走時表（`public/assets/tjma2001.txt`） | 気象庁 JMA2001（上野ほか, 2002） | 入手元URL未記録 |
| 震度観測点一覧（`JMAstations.json`） | 気象庁の震度観測点一覧に基づくもの | 入手元URL未記録 |
| AVS30・微地形区分（`public/assets/stations-avs30.json`） | 防災科研 J-SHIS 表層地盤データ V4（2020年版） | J-SHISの利用条件（出典明示） |
| 都道府県ポリゴン（`src/ui/japan.json`） | [dataofjapan/land](https://github.com/dataofjapan/land) の japan.geojson。元データは国土地理院「地球地図日本」 | 地球地図日本の出典明記が必要（非営利の場合。営利なら著作権者への利用報告も） |
| 震度予測の式（`src/lib/intensityPrediction.ts`） | 気象庁「緊急地震速報検討委員会 資料2-1」（平成20年3月18日）。宇津(1982)・佐藤ほか(1989)・宇津(2001)・司・翠川(1999)・松岡・翠川(1994)・翠川ほか(1999) | 学術文献の引用 |
| 欧文・数字フォント（`src/assets/montserrat*.woff2`） | [Montserrat](https://fonts.google.com/specimen/Montserrat) | SIL Open Font License 1.1 |
| 日本語フォント（`src/assets/notosansjp-subset.woff2`） | [Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP) | SIL Open Font License 1.1 |

このリポジトリ自体に LICENSE ファイルは無い（著作権者に権利が留保される）。
