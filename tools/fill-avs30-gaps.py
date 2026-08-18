#!/usr/bin/env python3
"""AVS30 が引けなかった観測点を、近傍のメッシュで埋める。

  python3 tools/fill-avs30-gaps.py public/assets/stations-avs30.json

引けない理由は2つとも座標の粒度に由来する:
  - HTTP 404: そのメッシュにデータが無い
  - AVS = 0 : 水域（沿岸海域・湖沼・河道）

観測点一覧の緯度経度は小数2桁（約1.1km）しかない。海岸沿いの点では、
実際は陸にある観測点が海側のメッシュに落ちる。250mメッシュに対して
座標のほうが粗いので、その分を近傍探索で埋める。

**埋めた点には印を残す**（fallbackKm に代用した距離）。
実測値と代用値が見分けられなくなるほうが困る。
"""
import json
import math
import ssl
import sys
import time
import urllib.parse
import urllib.request

API = "https://www.j-shis.bosai.go.jp/map/api/sstrct/V4/meshinfo.geojson"
SSL_CONTEXT = ssl.create_default_context(cafile="/etc/ssl/cert.pem")

# 探す距離（km）。250mメッシュなので、まず隣、次にその外側
RINGS_KM = [0.3, 0.6, 1.0, 1.5]
AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315]


def fetch(lon, lat):
    url = f"{API}?{urllib.parse.urlencode({'position': f'{lon:.5f},{lat:.5f}', 'epsg': 4326})}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "eew-view/0.1"})
        with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as res:
            data = json.load(res)
        features = data.get("features") or []
        if not features:
            return None
        props = features[0].get("properties") or {}
        avs = props.get("AVS")
        value = float(avs) if avs not in (None, "") else 0.0
        if value <= 0:
            return None
        return {"avs30": value, "jname": props.get("JNAME"), "mesh": props.get("meshcode")}
    except Exception:  # noqa: BLE001 - 見つからなければ次の候補へ
        return None


def offset(lat, lon, km, azimuth_deg):
    """指定方位・距離だけずらした地点"""
    rad = math.radians(azimuth_deg)
    dlat = (km * math.cos(rad)) / 111.195
    dlon = (km * math.sin(rad)) / (111.195 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def main(path):
    data = json.load(open(path))
    stations = data["stations"]
    gaps = [s for s in stations if not s.get("avs30")]
    print(f"欠測 {len(gaps)} 点を近傍で埋める", file=sys.stderr)

    filled = 0
    for i, s in enumerate(gaps, 1):
        for km in RINGS_KM:
            hit = None
            for az in AZIMUTHS:
                lat, lon = offset(s["lat"], s["lon"], km, az)
                hit = fetch(lon, lat)
                time.sleep(0.05)
                if hit:
                    break
            if hit:
                s.update(hit)
                # 実測値ではなく近傍で代用したことを残す
                s["fallbackKm"] = km
                filled += 1
                break
        if i % 20 == 0:
            print(f"  {i}/{len(gaps)}", file=sys.stderr, flush=True)

    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    remaining = sum(1 for s in stations if not s.get("avs30"))
    print(
        f"近傍で埋めた {filled} 点 / 残る欠測 {remaining} 点 -> {path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/assets/stations-avs30.json")
