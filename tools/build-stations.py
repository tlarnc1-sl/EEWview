#!/usr/bin/env python3
"""JMAstations.json (1.7MB) から、描画に要る座標だけを抜いて src/ui/stations.json を作る。

P2Pの points は観測点名（addr）しか持たないので、座標はここで引く。

**観測点の座標だけを持つ。** 区域（isArea=true の震度速報）には座標を持たせない。
区域は面であって点ではなく、所属観測点の重心のような「それらしい点」を作ると、
気象庁が発表していない位置を発表内容として描くことになる。
区域別の震度は地図に打たず、一覧に出す（区域ポリゴンを入れるまでの扱い）。

出力:
  { "s": { "<観測点名>": [lon, lat] } }

実行:  python3 tools/build-stations.py JMAstations.json src/ui/stations.json
"""
import json
import sys


def main(src, dst):
    stations = json.load(open(src))
    s = {}

    for st in stations:
        try:
            lon = round(float(st["lon"]), 3)
            lat = round(float(st["lat"]), 3)
        except (KeyError, TypeError, ValueError):
            continue
        name = st.get("name")
        if name and name not in s:
            s[name] = [lon, lat]

    with open(dst, "w") as f:
        json.dump({"s": s}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(s)} stations -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "src/ui/stations.json")
