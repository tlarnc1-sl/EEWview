#!/usr/bin/env python3
"""日本語フォント（Noto Sans JP）を、このアプリで出る文字だけに絞って同梱する。

  python3 tools/build-jp-font.py

なぜ絞るか: 全グリフだと 4.2MB。このアプリが表示する日本語は
**観測点名・市町村名・区域名・都道府県名・UIの文言**に限られ、実測で1630文字。
そこまで絞ると 610KB（可変フォント1本、太さ100-900）で収まる。

静的2本（400と700）だと合計 649KB。可変のほうが小さく、太さも自由に使える。

未知の文字が来たとき（新しい観測点名など）は、CSSの次の候補（端末のゴシック）に
字ごとに落ちる。豆腐にはならない。文字が増えたらこれを再実行する。

要るもの: fonttools, brotli （pip install fonttools brotli）
"""
import glob
import json
import os
import re
import subprocess
import sys
import unicodedata

SOURCE_URL = (
    'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/'
    'NotoSansJP%5Bwght%5D.ttf'
)
CACHE = 'tools/.cache/NotoSansJP-VF.ttf'
OUTPUT = 'src/assets/notosansjp-subset.woff2'

# 仮名・約物・全角英数など、字種としてまとめて入れておく範囲
RANGES = ','.join(
    [
        'U+0020-007E',  # ASCII（記号込み）
        'U+00B0',  # 度
        'U+2010-2027',  # ダッシュ・引用符
        'U+2190-21FF',  # 矢印
        'U+25A0-25FF',  # 幾何図形（▸▾など）
        'U+3000-303F',  # 和文約物
        'U+3040-30FF',  # 平仮名・片仮名
        'U+31F0-31FF',  # 片仮名拡張
        'U+FF00-FFEF',  # 全角英数・半角カナ
    ]
)


def collect_chars() -> set[str]:
    """このアプリが出す日本語を全部集める"""
    chars: set[str] = set()

    # 観測点・市町村・区域・都道府県・ふりがな・観測主体
    for s in json.load(open('JMAstations.json')):
        for value in (
            s.get('name'),
            s.get('furigana'),
            (s.get('city') or {}).get('name'),
            (s.get('city') or {}).get('furigana'),
            (s.get('area') or {}).get('name'),
            (s.get('area') or {}).get('furigana'),
            (s.get('pref') or {}).get('name'),
            (s.get('pref') or {}).get('furigana'),
            s.get('affi'),
        ):
            if value:
                chars |= set(value)

    # 地図の都道府県名
    for pref in json.load(open('src/ui/japan.json'))['prefs']:
        chars |= set(pref['name'])

    # 実データ（津波の区域名、気象庁の文言、観測点名）
    for path in glob.glob('fixtures/*.json'):
        chars |= set(re.findall(r'[^\x00-\x7f]', open(path).read()))

    # UIの文言（ソース中の日本語）
    for path in glob.glob('src/**/*.ts', recursive=True):
        chars |= set(re.findall(r'[^\x00-\x7f]', open(path).read()))

    return chars


def main() -> None:
    chars = collect_chars()
    kanji = {c for c in chars if unicodedata.category(c) == 'Lo' and '一' <= c <= '鿿'}
    print(f'文字種 {len(chars)}（うち漢字 {len(kanji)}）', file=sys.stderr)

    os.makedirs('tools/.cache', exist_ok=True)
    if not os.path.exists(CACHE):
        print('元フォントを取得中…', file=sys.stderr)
        subprocess.run(['curl', '-sL', SOURCE_URL, '-o', CACHE], check=True)

    charset_path = 'tools/.cache/jp-charset.txt'
    with open(charset_path, 'w') as f:
        f.write(''.join(sorted(chars)))

    subprocess.run(
        [
            'python3', '-m', 'fontTools.subset', CACHE,
            f'--text-file={charset_path}',
            f'--unicodes={RANGES}',
            '--layout-features=*',
            '--flavor=woff2',
            f'--output-file={OUTPUT}',
        ],
        check=True,
    )
    print(f'{OUTPUT} {os.path.getsize(OUTPUT) / 1024:.0f}KB', file=sys.stderr)


if __name__ == '__main__':
    main()
