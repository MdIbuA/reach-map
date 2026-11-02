"""Step 2: turn raw places + population into the layers the map loads.

Inputs
  pipeline/out/places_raw.parquet   (step 1, Overture Maps Places on S3)
  pipeline/out/areas_raw.parquet    (step 1, Overture Maps Divisions on S3)
  HRSL population raster            (Meta + CIESIN High Resolution Settlement
                                     Layer, Registry of Open Data on AWS, read
                                     straight from S3 as a Cloud-Optimized
                                     GeoTIFF: only the Chennai window is fetched)

Outputs (site/data/)
  essentials.json  every essential place: [lon, lat, category index, name]
  hexes.json       H3 resolution-9 cells (~0.1 km2) with population and the
                   straight-line distance to the nearest place of each kind
  summary.json     city-wide numbers the page quotes, plus the worst-served
                   named areas

The straight-line numbers are a first estimate only. The map replaces them
with a real walking area from Amazon Location Service when someone clicks.
"""
from __future__ import annotations

import json
import math
import pathlib
import re
from collections import defaultdict

import h3
import numpy as np
import pyarrow.parquet as pq
import rasterio
import rasterio.windows
from scipy.spatial import cKDTree

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "pipeline" / "out"
SITE = ROOT / "site" / "data"

BBOX = dict(xmin=80.12, xmax=80.34, ymin=12.82, ymax=13.25)
POP_COG = (
    "/vsicurl/https://dataforgood-fb-data.s3.amazonaws.com/hrsl-cogs/"
    "hrsl_general/v1.5/cog_globallat_10_lon_80_general-v1.5.2.tif"
)
H3_RES = 9

# Walking model for the straight-line estimate:
# Calibrated against 35 Amazon Location pedestrian routes (pipeline/calibrate.py):
# median speed 57.8 m/min (3.5 km/h), median street/straight-line ratio 1.35.
WALK_M_PER_MIN = 57.8
DETOUR = 1.35
REACH_MIN = 15
REACH_M = REACH_MIN * WALK_M_PER_MIN / DETOUR  # ~642 m as the crow flies

MIN_CONFIDENCE = 0.5

# The six everyday essentials. Order matters: the site indexes by position.
ESSENTIALS: list[tuple[str, str, set[str], set[str]]] = [
    # key, label, Overture basic_category values, extra taxonomy.primary values
    ("hospital", "Hospital or clinic",
     {"hospital", "primary_care_or_general_clinic", "pediatric_clinic"}, set()),
    ("pharmacy", "Pharmacy", {"pharmacy_and_drug_store"}, set()),
    ("school", "School",
     {"elementary_school", "middle_school", "high_school"},
     {"school", "private_school", "public_school"}),
    ("grocery", "Grocery or market", {"farmers_market"},
     {"grocery_store", "indian_grocery_store", "organic_grocery_store",
      "supermarket", "convenience_store", "fruits_and_vegetables_store"}),
    ("park", "Park", {"park"}, set()),
    ("transit", "Train, metro or bus station",
     set(), {"bus_station", "train_station", "metro_station",
             "public_transit_facility_or_service"}),
]


def classify(row: dict) -> int | None:
    for i, (_, _, basics, cats) in enumerate(ESSENTIALS):
        if row["basic_category"] in basics or row["category"] in cats:
            return i
    return None


def clean_name(name: str | None) -> str:
    name = re.sub(r"\s+", " ", (name or "").strip())
    return name[:80] or "Unnamed"


def load_essentials() -> list[list]:
    rows = pq.read_table(OUT / "places_raw.parquet").to_pylist()
    kept, dropped = [], defaultdict(int)
    seen = set()
    for r in rows:
        k = classify(r)
        if k is None:
            continue
        if (r["confidence"] or 0) < MIN_CONFIDENCE or r["operating_status"] in (
            "permanently_closed", "temporarily_closed"):
            dropped[k] += 1
            continue
        # Drop exact duplicates (same kind, same name, within ~10 m).
        key = (k, clean_name(r["name"]).lower(), round(r["lon"], 4), round(r["lat"], 4))
        if key in seen:
            continue
        seen.add(key)
        kept.append([round(r["lon"], 6), round(r["lat"], 6), k, clean_name(r["name"])])
    for i, (key, *_rest) in enumerate(ESSENTIALS):
        n = sum(1 for p in kept if p[2] == i)
        print(f"  {key:9s} kept {n:5d}  dropped (low confidence/closed) {dropped[i]:5d}")
    return kept


def load_population() -> dict[str, float]:
    """Sum the ~30 m HRSL cells into H3 cells."""
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(POP_COG) as src:
            win = rasterio.windows.from_bounds(
                BBOX["xmin"], BBOX["ymin"], BBOX["xmax"], BBOX["ymax"], src.transform)
            arr = src.read(1, window=win)
            tf = src.window_transform(win)
    rows, cols = np.nonzero(np.nan_to_num(arr) > 0)
    xs = tf.c + (cols + 0.5) * tf.a
    ys = tf.f + (rows + 0.5) * tf.e
    pop: dict[str, float] = defaultdict(float)
    for x, y, v in zip(xs, ys, arr[rows, cols]):
        pop[h3.latlng_to_cell(float(y), float(x), H3_RES)] += float(v)
    print(f"  population {sum(pop.values()):,.0f} in {len(pop)} H3 cells")
    return pop


def to_xy(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Local equirectangular metres; accurate to <0.1% across one city."""
    lat0 = math.radians((BBOX["ymin"] + BBOX["ymax"]) / 2)
    return np.column_stack([
        np.radians(lon) * 6371000 * math.cos(lat0),
        np.radians(lat) * 6371000,
    ])


def main() -> None:
    SITE.mkdir(parents=True, exist_ok=True)
    print("essentials")
    places = load_essentials()
    print("population")
    pop = load_population()

    cells = [c for c, v in pop.items() if v >= 1]
    centres = np.array([h3.cell_to_latlng(c) for c in cells])  # (lat, lon)
    cxy = to_xy(centres[:, 1], centres[:, 0])

    pts = np.array([[p[0], p[1]] for p in places])
    kinds = np.array([p[2] for p in places])
    pxy = to_xy(pts[:, 0], pts[:, 1])

    dist = np.zeros((len(cells), len(ESSENTIALS)))
    for i in range(len(ESSENTIALS)):
        tree = cKDTree(pxy[kinds == i])
        dist[:, i], _ = tree.query(cxy)

    # Nearest named area for each cell, so the page can name the gaps.
    areas = [a for a in pq.read_table(OUT / "areas_raw.parquet").to_pylist()
             if a["name"]]
    axy = to_xy(np.array([a["lon"] for a in areas]), np.array([a["lat"] for a in areas]))
    _, area_idx = cKDTree(axy).query(cxy)

    hexes = []
    for j, c in enumerate(cells):
        hexes.append([c, round(pop[c]), *[int(round(d)) for d in dist[j]], int(area_idx[j])])

    # City-wide numbers.
    popv = np.array([h[1] for h in hexes], dtype=float)
    total = popv.sum()
    within = dist <= REACH_M
    share = {ESSENTIALS[i][0]: round(float(popv[within[:, i]].sum() / total), 4)
             for i in range(len(ESSENTIALS))}
    all6 = within.all(axis=1)
    hosp = within[:, 0]

    by_area: dict[int, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for j, h in enumerate(hexes):
        a = by_area[h[-1]]
        a[0] += h[1]
        a[1] += 0 if hosp[j] else h[1]
        a[2] += h[1] * dist[j, 0]
    worst = sorted(
        ([k, v[0], v[1], v[2] / v[0]] for k, v in by_area.items() if v[0] >= 5000),
        key=lambda x: -x[2])[:10]

    used_areas = sorted({h[-1] for h in hexes})
    remap = {old: new for new, old in enumerate(used_areas)}
    for h in hexes:
        h[-1] = remap[h[-1]]
    area_list = [[areas[i]["name"], round(areas[i]["lon"], 5), round(areas[i]["lat"], 5)]
                 for i in used_areas]

    summary = {
        "city": "Chennai",
        "population": round(total),
        "cells": len(hexes),
        "h3_resolution": H3_RES,
        "reach_minutes": REACH_MIN,
        "reach_crow_m": round(REACH_M),
        "walk_m_per_min": WALK_M_PER_MIN,
        "detour": DETOUR,
        "essentials": [{"key": k, "label": label,
                        "count": int((kinds == i).sum())}
                       for i, (k, label, *_r) in enumerate(ESSENTIALS)],
        "share_within_reach": share,
        "share_all_six": round(float(popv[all6].sum() / total), 4),
        "people_no_hospital": round(float(popv[~hosp].sum())),
        "worst_areas_for_hospital": [
            {"name": areas[k]["name"], "lon": areas[k]["lon"], "lat": areas[k]["lat"],
             "population": round(p), "people_beyond": round(b),
             "mean_crow_m": round(m)}
            for k, p, b, m in worst],
        "sources": {
            "places": "Overture Maps Foundation, Places theme, release 2026-10-21.0 "
                      "(s3://overturemaps-us-west-2), CDLA Permissive 2.0 / ODbL",
            "population": "Meta & CIESIN High Resolution Settlement Layer v1.5 "
                          "(s3://dataforgood-fb-data/hrsl-cogs), CC BY 4.0",
        },
    }

    def dump(name: str, obj) -> None:
        text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        (SITE / name).write_text(text, encoding="utf-8")
        print(f"  wrote {name} ({len(text) / 1024:.0f} KB)")

    print("output")
    dump("essentials.json", {"kinds": [e[0] for e in ESSENTIALS], "places": places})
    dump("hexes.json", {"fields": ["h3", "pop", *[e[0] for e in ESSENTIALS], "area"],
                        "areas": area_list, "cells": hexes})
    dump("summary.json", summary)
    print(json.dumps({k: summary[k] for k in
                      ("population", "share_within_reach", "share_all_six",
                       "people_no_hospital")}, indent=1))
    for w in summary["worst_areas_for_hospital"]:
        print(f'  {w["name"]:28s} pop {w["population"]:8,d}  beyond {w["people_beyond"]:8,d}  mean {w["mean_crow_m"]} m')


if __name__ == "__main__":
    main()
