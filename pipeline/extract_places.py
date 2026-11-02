"""Step 1: pull every Overture Maps place inside the Chennai bounding box.

Reads the public Overture Maps GeoParquet release straight from Amazon S3
(Registry of Open Data on AWS, bucket `overturemaps-us-west-2`). No AWS
account is needed: the bucket allows anonymous reads.

Parquet row-group statistics on the `bbox` column let pyarrow skip almost
the whole planet, so this downloads only the row groups that touch Chennai.

It also pulls Overture "divisions" (named neighbourhoods and localities) so
the map can say *where* the gaps are, not just show coloured hexagons.

Output: pipeline/out/places_raw.parquet, pipeline/out/areas_raw.parquet
"""
from __future__ import annotations

import pathlib
import time

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pf
import pyarrow.parquet as pq

RELEASE = "2026-10-21.0"
# Greater Chennai Corporation, with a small margin.
BBOX = dict(xmin=80.12, xmax=80.34, ymin=12.82, ymax=13.25)

OUT = pathlib.Path(__file__).parent / "out"


def main() -> None:
    OUT.mkdir(exist_ok=True)
    fs = pf.S3FileSystem(anonymous=True, region="us-west-2")
    path = f"overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/"
    dataset = ds.dataset(path, filesystem=fs, format="parquet")

    def b(k: str) -> ds.Expression:
        return ds.field("bbox", k)
    flt = (
        (b("xmin") >= BBOX["xmin"]) & (b("xmax") <= BBOX["xmax"])
        & (b("ymin") >= BBOX["ymin"]) & (b("ymax") <= BBOX["ymax"])
    )
    cols = {
        "id": ds.field("id"),
        "name": ds.field("names", "primary"),
        "basic_category": ds.field("basic_category"),
        "category": ds.field("taxonomy", "primary"),
        "hierarchy": ds.field("taxonomy", "hierarchy"),
        "confidence": ds.field("confidence"),
        "operating_status": ds.field("operating_status"),
        "lon": b("xmin"),
        "lat": b("ymin"),
    }
    t = time.time()
    table = dataset.to_table(columns=cols, filter=flt)
    print(f"{table.num_rows} places in {time.time() - t:.0f}s")
    pq.write_table(table, OUT / "places_raw.parquet")
    top = pc.value_counts(table["basic_category"]).to_pylist()
    top.sort(key=lambda d: -d["counts"])
    for d in top[:25]:
        print(f'{d["counts"]:6d}  {d["values"]}')

    # Named areas: neighbourhoods, macrohoods, localities.
    path = f"overturemaps-us-west-2/release/{RELEASE}/theme=divisions/type=division/"
    divisions = ds.dataset(path, filesystem=fs, format="parquet")
    sub = ds.field("subtype")
    areas = divisions.to_table(
        columns={
            "id": ds.field("id"),
            "name": ds.field("names", "primary"),
            "subtype": sub,
            "lon": b("xmin"),
            "lat": b("ymin"),
        },
        filter=flt & sub.isin(["neighborhood", "macrohood", "microhood", "locality"]),
    )
    print(f"{areas.num_rows} named areas")
    print(pc.value_counts(areas["subtype"]).to_pylist())
    pq.write_table(areas, OUT / "areas_raw.parquet")


if __name__ == "__main__":
    main()
