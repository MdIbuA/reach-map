# How far is help? Chennai on foot

**About 988,000 people in and around Chennai live more than a 15-minute walk from the nearest hospital or clinic.** This map shows where they live. Click any spot and Amazon Location Service draws the real 15-minute walk from there, then counts the essentials inside it.

**Live map:** _add your Amplify URL here_
**Built for:** AWS Builder Center Weekend Challenge, "Map it" (Oct 30 – Nov 2, 2026)

## What you can do on it

- **See the city's gaps at a glance.** About 6,700 hexagons (H3 resolution 9, ~0.1 km² each) cover every populated part of Chennai. Each is coloured by how many minutes it takes to walk to the nearest hospital, pharmacy, school, grocery, park or station, or by how many of the six are within 15 minutes ("All six").
- **Click anywhere to walk it for real.** Amazon Location Service returns the **5, 10 and 15-minute walking areas** from that point (`CalculateIsolines`, pedestrian). The page then:
  - counts every hospital, pharmacy, school, grocery, park and station inside the 15-minute area
  - names what's missing ("Missing: park, train, metro or bus station")
  - routes you on foot to the nearest hospital or clinic (`CalculateRoutes`) and says how far over 15 minutes it is
  - compares the real walk with the 1.2 km circle that "15 minutes" would cover in straight lines. Rivers, railway lines and dead-end streets shrink it, and the page says by how much.
- **Search any address** (Amazon Location `Geocode`) and the walk runs from there.
- **Furthest from a hospital:** the ten named areas with the most people beyond a 15-minute walk. Tap one to check it.
- **Share a walk.** The URL keeps the point (`#@12.98150,80.22070`).

## What the map shows (city-wide)

| Essential | Share of 8.48 M people within ~15 min on foot |
|---|---|
| Hospital or clinic | 88% |
| Pharmacy | 87% |
| School | 95% |
| Grocery or market | 83% |
| Park | 66% |
| Train, metro or bus station | 71% |
| **All six** | **52%** |

The gaps aren't in the old city. They're on the edges where Chennai grew fastest: Alinjivakkam, Vadaperumbakkam and Manjampakkam in the north and north-west, and Sholinganallur and Nookampalayam along the IT corridor in the south.

These are city-wide *estimates* (straight-line × 1.35 detour at 4.8 km/h). Clicking replaces the estimate with real streets for that spot.

## Datasets

| Dataset | What's in it | Where it comes from |
|---|---|---|
| **Overture Maps Places**, release `2026-10-21.0` | 139,332 places in the Chennai box; 6,533 kept as essentials (confidence ≥ 0.5, not closed) | GeoParquet on S3, `s3://overturemaps-us-west-2`, [Registry of Open Data on AWS](https://registry.opendata.aws/overture/) |
| **Overture Maps Divisions** | 762 named neighbourhoods and localities, used to name the gaps | same release |
| **High Resolution Settlement Layer** v1.5 (Meta & CIESIN) | Population per ~30 m cell; 8.48 M people in the box | Cloud-Optimized GeoTIFF on S3, `s3://dataforgood-fb-data/hrsl-cogs`, [Registry of Open Data on AWS](https://registry.opendata.aws/dataforgood-fb-hrsl/) |

There's no personal data. Every place is a public business or facility, and population is modelled per grid cell.

## How it's built

```
 Registry of Open Data on AWS (S3)                     Browser (Amplify Hosting)
 ┌────────────────────────────────┐                   ┌──────────────────────────────────┐
 │ Overture Places  (GeoParquet)  │─┐                 │ MapLibre + Amazon Location Maps  │
 │ Overture Divisions (GeoParquet)│─┼─ pipeline/ ──►  │  data/hexes.json  (6.7k H3 cells)│
 │ HRSL population  (COG)         │─┘  pyarrow,       │  data/essentials.json (6.5k pts) │
 └────────────────────────────────┘    rasterio, h3   │  data/summary.json               │
                                                      │        │ click / search          │
                                                      │        ▼                         │
                                                      │ Amazon Location Service (API key)│
                                                      │  Routes: CalculateIsolines        │
                                                      │  Routes: CalculateRoutes          │
                                                      │  Places: Geocode                  │
                                                      └──────────────────────────────────┘
```

**1. Read only the slice you need from S3.** `pipeline/extract_places.py` opens Overture's planet-scale GeoParquet with `pyarrow.dataset` and filters on the `bbox` struct column. Parquet row-group statistics let it skip almost the whole planet, so Chennai's 139k places arrive in **about 3 seconds**, with no AWS account and nothing downloaded in full. `pipeline/build_layers.py` reads only the Chennai window of the HRSL raster over HTTP range requests (it's a COG).

**2. Precompute the city layer.** Population is summed into H3 resolution-9 cells. A KD-tree gives each cell the straight-line distance to the nearest place of each kind. That becomes the estimated walk in minutes (× 1.35 detour, 80 m/min). Each cell is tagged with its nearest named area. Output is three small JSON files (~720 KB total), served as static files.

**3. Ask Amazon Location for the truth on demand.** One click makes two calls:

```http
POST https://routes.geo.us-east-1.amazonaws.com/v2/isolines?key=…
{ "Origin": [80.2207, 12.9815], "Thresholds": { "Time": [300, 600, 900] },
  "TravelMode": "Pedestrian", "IsolineGeometryFormat": "Simple" }

POST https://routes.geo.us-east-1.amazonaws.com/v2/routes?key=…
{ "Origin": [...], "Destination": [...], "TravelMode": "Pedestrian", "LegGeometryFormat": "Simple" }
```

Point-in-polygon runs in the browser against the 6.5k essentials, so counting is instant and costs nothing.

**Why Amazon Location Service?** It's the only part of the stack that knows the streets. Straight-line distance can't see that the Adyar river, the MRTS line or a gated campus turns a 600 m hop into a 2 km walk. Isolines answer the question the map is really asking ("what can I reach?") in one call, and an API key with a referrer restriction means no backend, no Cognito and no server to run.

**Why precompute the city layer instead of calling isolines for every hexagon?** 6,700 isolines per build would cost real money and add nothing a visitor can't get by clicking. The estimate shows the pattern; the click checks it.

**It degrades gracefully.** Without an API key, or if Amazon Location is unreachable, the map still works. Walks fall back to clearly labelled straight-line rings.

### AWS services

| Service | Role |
|---|---|
| **Amazon Location Service** | Base map (Maps, Monochrome style), walking isolines and routes (Routes), search (Places Geocode). One referrer-restricted API key. |
| **Amazon S3** (Registry of Open Data on AWS) | Source of both datasets, read in place: GeoParquet via predicate pushdown, COG via range requests |
| **AWS Amplify Hosting** | Builds from GitHub on each push, injects the API key from an environment variable, serves over HTTPS |

## Reuse it for your city

1. Change `BBOX` in `pipeline/extract_places.py` and `pipeline/build_layers.py`, and `POP_COG` to the HRSL tile covering your city (tiles are listed in `hrsl_general-latest.vrt`).
2. `pip install -r pipeline/requirements.txt`
3. `python pipeline/extract_places.py && python pipeline/build_layers.py`
4. Change `CENTER` in `site/app.js` and the copy in `site/index.html`.
5. Serve `site/` locally (`python -m http.server -d site`) or deploy with the steps below.

To track a different set of essentials, edit the `ESSENTIALS` list in `build_layers.py`. Each entry maps Overture `basic_category` and `taxonomy.primary` values to one layer.

## Deploy (AWS Amplify + Amazon Location)

1. **Amplify:** Console → AWS Amplify → *Create new app* → GitHub → `MdIbuA/reach-map`, branch `main`. It picks up `amplify.yml`. Deploy once and copy the domain (`https://main.xxxx.amplifyapp.com`).
2. **API key:** Console → Amazon Location Service (region **us-east-1**) → *API keys* → *Create API key*.
   - Name: `reach-map-web`
   - Allowed actions: **Maps** `GetTile` (and `GetStaticMap` if listed), **Places** `Geocode`, **Routes** `CalculateIsolines` and `CalculateRoutes`
   - Allowed referrers: `https://main.xxxx.amplifyapp.com/*` and `http://localhost:8000/*`
   - Expiry: a date after judging, for example 2026-12-31
3. **Wire it in:** Amplify → the app → *Hosting → Environment variables*. Add `LOCATION_API_KEY` = the key value and `LOCATION_REGION` = `us-east-1`. Then *Redeploy this version*.
4. Open the site, click the map, and check that the teal walking area isn't a perfect circle and the legend says "real walk".

Cost at demo scale is inside the Amazon Location free tier and Amplify's free tier. Set an AWS Budget alert anyway.

## The catch

- **The hexagon colours are estimates.** Clicking gives real streets for one point. The city-wide numbers (88%, 988,000) come from the estimate.
- **Overture has gaps in India.** It misses some government primary health centres and many small kirana shops, and "hospital" includes private nursing homes. That probably makes the map *too optimistic* about clinics and *too pessimistic* about groceries.
- **Transit means stations.** MTC roadside bus stops aren't in Overture Places.
- **Reach isn't access.** A clinic 5 minutes away can still be full, unaffordable or closed at night.
- **The box is a box.** It covers the Greater Chennai Corporation area plus edges of Tiruvallur and Chengalpattu districts.

## Licences

Code: MIT. Places and divisions © Overture Maps Foundation (CDLA Permissive 2.0, with ODbL for OpenStreetMap-derived data). Population: Meta & CIESIN HRSL, CC BY 4.0. Base map and routing © Amazon Location Service data providers. Vendored MapLibre GL JS (BSD-3) and h3-js (Apache 2.0) licences are in `site/vendor/`.
