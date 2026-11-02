"""Step 3 (optional): check the straight-line model against real walks.

Samples populated H3 cells, asks Amazon Location Service (Routes v2,
CalculateRoutes, Pedestrian) for the walk to the nearest hospital or clinic,
and compares it with the straight-line distance.

    LOCATION_API_KEY=v1.public... python pipeline/calibrate.py

Result on 2026-11-02 (35 routes): median detour 1.35 (street / straight
line), median pedestrian speed 57.8 m/min (3.5 km/h). build_layers.py uses
those two numbers.
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import random
import statistics as st
import urllib.request

import h3

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGION = os.environ.get("LOCATION_REGION", "us-east-1")
KEY = os.environ["LOCATION_API_KEY"]
REFERER = os.environ.get("LOCATION_REFERER", "")
LAT0 = math.radians(13.04)


def metres(a, b) -> float:
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(LAT0), (a[1] - b[1]) * 111320)


def route(origin, dest) -> tuple[float, float]:
    req = urllib.request.Request(
        f"https://routes.geo.{REGION}.amazonaws.com/v2/routes?key={KEY}",
        data=json.dumps({"Origin": origin, "Destination": dest, "TravelMode": "Pedestrian"}).encode(),
        headers={"Content-Type": "application/json", **({"Referer": REFERER} if REFERER else {})},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        legs = json.load(r)["Routes"][0]["Legs"]
    o = [leg["PedestrianLegDetails"]["Summary"]["Overview"] for leg in legs]
    return sum(x["Distance"] for x in o), sum(x["Duration"] for x in o)


def main(n: int = 40) -> None:
    hexes = json.loads((ROOT / "site/data/hexes.json").read_text())
    ess = json.loads((ROOT / "site/data/essentials.json").read_text())
    hosp = [p for p in ess["places"] if p[2] == 0]
    random.seed(7)
    rows = []
    for c in random.sample([c for c in hexes["cells"] if c[1] >= 300], n):
        lat, lon = h3.cell_to_latlng(c[0])
        o = [round(lon, 5), round(lat, 5)]
        near = min(hosp, key=lambda p: metres(o, p))
        crow = metres(o, near)
        if crow < 100:
            continue
        try:
            d, t = route(o, [near[0], near[1]])
        except Exception as e:  # noqa: BLE001
            print("skip", e)
            continue
        rows.append((crow, d, t))
    print(f"{len(rows)} routes")
    print("median detour", round(st.median(d / c for c, d, _ in rows), 2))
    print("median speed m/min", round(st.median(d / t * 60 for _, d, t in rows), 1))
    (ROOT / "pipeline/calibration_routes.json").write_text(json.dumps(
        [{"crow_m": round(c), "street_m": d, "seconds": t} for c, d, t in rows], indent=0))


if __name__ == "__main__":
    main()
