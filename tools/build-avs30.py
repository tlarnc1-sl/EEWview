#!/usr/bin/env python3
"""震度観測点にJ-SHISのAVS30を突き合わせて、静的JSONを作る。

  python3 tools/build-avs30.py JMAstations.json public/assets/stations-avs30.json

J-SHIS 表層地盤データ（V4 = 2020年版）を1点ずつ引く。4400点あるので:
  - 同時実行は控えめ（既定4）にして、リクエスト間に少し待つ
  - 途中経過を tools/.cache/avs30-cache.json に貯め、再実行で続きから
  - 失敗した点は黙って0で埋めず、AVSなしとして残す（欠測が分かるように）

ARV も返ってくるが、こちらは工学的基盤Vs=400m/s基準なので使わない。
AVS を取って (600/AVS)^0.66 で自分で換算するほうが、震度予測の式と一貫する。
JNAME（微地形区分名）は、値がおかしいときの検証材料として一緒に保存する。
"""
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://www.j-shis.bosai.go.jp/map/api/sstrct/V4/meshinfo.geojson"
# このPythonにはCA束が入っていないので、システムの束を明示的に使う
SSL_CONTEXT = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
CACHE_PATH = "tools/.cache/avs30-cache.json"
WORKERS = 6
RETRIES = 3
PAUSE_SEC = 0.05

lock = threading.Lock()
cache = {}
done = 0


def load_cache():
    global cache
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            cache = json.load(f)
    print(f"cache: {len(cache)} 件", file=sys.stderr)


def save_cache(snapshot):
    """スナップショットを書き出す。

    **ロックを取らない。** 呼び出し側がロック内で複製を作って渡すこと。
    threading.Lock は再入できないので、ロックを持ったままここで取り直すと固まる。
    """
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(snapshot, f, ensure_ascii=False)
    os.replace(tmp, CACHE_PATH)


def fetch(lon, lat):
    """1メッシュ分の表層地盤データ。取れなければ None"""
    # position は「経度,緯度」の順。逆にすると日本の外を指して NOT_FOUND になる
    url = f"{API}?{urllib.parse.urlencode({'position': f'{lon},{lat}', 'epsg': 4326})}"
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "eew-view/0.1"})
            with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as res:
                data = json.load(res)
            features = data.get("features") or []
            if not features:
                return {"avs30": None, "reason": "empty"}
            props = features[0].get("properties") or {}
            avs = props.get("AVS")
            return {
                "avs30": float(avs) if avs not in (None, "") else None,
                "jname": props.get("JNAME"),
                "mesh": props.get("meshcode") or data.get("metaData", {}).get("meshcode"),
            }
        except urllib.error.HTTPError as err:
            # 404 はそのメッシュにデータが無いということ。再試行しても変わらない。
            # 座標が約1km精度なので、海側のメッシュを指した海岸沿いの点で起きる
            if err.code in (400, 404):
                return {"avs30": None, "reason": f"http{err.code}"}
            if attempt == RETRIES - 1:
                print(f"  失敗 {lon},{lat}: {err}", file=sys.stderr)
                return {"avs30": None, "reason": str(err)}
            time.sleep(1.5 * (attempt + 1))
        except Exception as err:  # noqa: BLE001 - 握り潰さず記録して再試行
            if attempt == RETRIES - 1:
                print(f"  失敗 {lon},{lat}: {err}", file=sys.stderr)
                return {"avs30": None, "reason": str(err)}
            time.sleep(1.5 * (attempt + 1))
    return {"avs30": None, "reason": "unknown"}


def key_of(lon, lat):
    return f"{lon},{lat}"


def work(item, total):
    global done
    lon, lat = item
    k = key_of(lon, lat)
    with lock:
        if k in cache:
            done += 1
            return
    result = fetch(lon, lat)
    time.sleep(PAUSE_SEC)

    snapshot = None
    with lock:
        cache[k] = result
        done += 1
        count = done
        if done % 200 == 0:
            # 書き出しはロックの外でやる。中で save_cache を呼ぶと固まる
            snapshot = dict(cache)
    if snapshot is not None:
        print(f"  {count}/{total}", file=sys.stderr, flush=True)
        save_cache(snapshot)


def main(src, dst):
    stations = json.load(open(src))
    # 観測点名は一意。コードは市町村コードなので重複する
    coords = []
    seen = set()
    for s in stations:
        try:
            lon = round(float(s["lon"]), 4)
            lat = round(float(s["lat"]), 4)
        except (KeyError, TypeError, ValueError):
            continue
        k = key_of(lon, lat)
        if k not in seen:
            seen.add(k)
            coords.append((lon, lat))

    print(f"観測点 {len(stations)} 件 / 座標 {len(coords)} 通り", file=sys.stderr)
    load_cache()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(lambda c: work(c, len(coords)), coords))
    save_cache(dict(cache))

    out = []
    missing = 0
    for s in stations:
        try:
            lon = round(float(s["lon"]), 4)
            lat = round(float(s["lat"]), 4)
        except (KeyError, TypeError, ValueError):
            continue
        hit = cache.get(key_of(lon, lat)) or {}
        avs = hit.get("avs30")
        if avs is None:
            missing += 1
        out.append(
            {
                "name": s.get("name"),
                "code": s.get("code"),
                "lat": lat,
                "lon": lon,
                "pref": (s.get("pref") or {}).get("name"),
                "area": (s.get("area") or {}).get("name"),
                "avs30": avs,
                "jname": hit.get("jname"),
                "mesh": hit.get("mesh"),
            }
        )

    payload = {
        "source": {
            "stations": "気象庁 震度観測点一覧（JMAstations.json）",
            "avs30": "防災科研 J-SHIS 表層地盤データ V4（2020年版）",
            "note": "AVS30は地表から地下30mまでの平均S波速度 (m/s)。"
            "増幅率は (600/AVS30)^0.66 で基準基盤600m/s比に換算する。",
        },
        "stations": out,
    }
    with open(dst, "w") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    values = [s["avs30"] for s in out if s["avs30"] is not None]
    values.sort()
    print(
        f"{len(out)} 点 -> {dst}（AVSなし {missing} 点 / "
        f"中央値 {values[len(values) // 2]:.0f} m/s）",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "public/assets/stations-avs30.json")
