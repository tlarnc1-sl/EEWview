#!/usr/bin/env python3
"""japan.geojson (dataofjapan/land, ~13MB) を画面用に間引いて src/ui/japan.json を作る。

出典: dataofjapan/land の japan.geojson。その元データは
**国土地理院「地球地図日本」**（https://www.gsi.go.jp/kankyochiri/gm_jpn.html）。
配布元の条件により、非営利利用でも「地球地図日本」の出典明記が要る。

出力形式:
  { "prefs": [ { "code": 26, "name": "京都府", "rings": [ [x, y, x, y, ...], ... ] } ] }

座標は [lon, lat] を交互に並べた flat 配列（0.01度に丸め）。
実行:  python3 tools/build-map.py /tmp/japan.geojson
"""
import json
import sys
import math

EPS = 0.012          # RDP 許容誤差（度）≒ 1.2km
MIN_AREA = 0.004     # これ未満の面積のリングは捨てる（小島）
ROUND = 2


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    # 反復版 Douglas-Peucker（再帰だと深さ制限に当たる）
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = pts[i]
        bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, best_i = d, k
        if best > eps:
            keep[best_i] = True
            stack.append((i, best_i))
            stack.append((best_i, j))
    return [p for p, k in zip(pts, keep) if k]


def ring_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def polygons(geom):
    t = geom["type"]
    if t == "Polygon":
        return [geom["coordinates"]]
    if t == "MultiPolygon":
        return geom["coordinates"]
    raise ValueError(t)


def main(src, dst):
    data = json.load(open(src))
    prefs = []
    total = 0
    for feat in data["features"]:
        props = feat["properties"]
        rings = []
        for poly in polygons(feat["geometry"]):
            outer = poly[0]  # 穴は無視（湖沼まで描く必要はない）
            if ring_area(outer) < MIN_AREA:
                continue
            simple = rdp([(float(x), float(y)) for x, y in outer], EPS)
            if len(simple) < 4:
                continue
            flat = []
            for x, y in simple:
                flat.append(round(x, ROUND))
                flat.append(round(y, ROUND))
            rings.append(flat)
            total += len(simple)
        if not rings:
            continue
        rings.sort(key=len, reverse=True)
        prefs.append({"code": props["id"], "name": props["nam_ja"], "rings": rings})
    prefs.sort(key=lambda p: p["code"])
    out = {"prefs": prefs}
    with open(dst, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(prefs)} prefs / {total} points -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "src/ui/japan.json")
