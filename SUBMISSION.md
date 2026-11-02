# Submission kit: "Map it" weekend challenge

Copy-paste material for the Builder Center form, plus the demo video script.
Replace `http://reachmapbucket.s3-website-us-east-1.amazonaws.com` and `VIDEO_URL` before posting.

---

## Title

How far is help? Chennai on foot

## One-liner

About 1.6 million people in and around Chennai live more than a 15-minute walk from a hospital or clinic. Click anywhere on the map and Amazon Location Service draws your real 15-minute walk, then counts what's inside it.

## Write-up

**The question.** "Is there a hospital near me?" is a question about *walking*, not about distance. In Chennai a clinic 600 m away can be across the Adyar river, a railway line or a gated campus, and that 600 m becomes a 25-minute walk. I wanted a map that answers the real question for every part of my city, and lets anyone check it from their own street.

**The datasets.** Both come from the Registry of Open Data on AWS and are read in place from S3:
- **Overture Maps Places** (release 2026-10-21.0, GeoParquet): 139,332 places in the Chennai box, filtered to 6,533 everyday essentials: hospitals and clinics, pharmacies, schools, groceries and markets, parks, and train, metro and bus stations. I kept places with confidence ≥ 0.5 that aren't marked closed. Overture Divisions gives 762 neighbourhood names, so the map can name the gaps.
- **High Resolution Settlement Layer** (Meta & CIESIN, Cloud-Optimized GeoTIFF): modelled population per ~30 m cell, 8.48 million people in the box.

**How it gets on the map.**
1. A Python pipeline reads only Chennai out of planet-scale files. Parquet row-group statistics on Overture's `bbox` column skip the rest of the world, so the places arrive in about 3 seconds. HTTP range requests pull just the Chennai window of the population raster.
2. Population is summed into ~6,700 H3 hexagons (resolution 9). A KD-tree gives each hexagon the straight-line distance to the nearest essential of each kind, which becomes an estimated walk in minutes.
3. The site draws those hexagons on an **Amazon Location Service** base map. When you click (or search an address with Amazon Location **Geocode**), it calls Amazon Location **Routes**:
   - **CalculateIsolines** (pedestrian, 5/10/15 min) for the real walking area
   - **CalculateRoutes** for the walk to the nearest hospital or clinic
   
   The browser counts the essentials inside the 15-minute area and lists what's missing.
4. **Calibration.** I asked Amazon Location for 35 real walks from random populated hexagons to their nearest clinic. The median street route was **1.35×** the straight line, at **3.5 km/h**. The city-wide estimate uses exactly those numbers, so it agrees with what a click shows.
5. **Amazon S3** static website hosting serves the site: about 2 MB of HTML, JS and JSON, with the referrer-restricted Location API key in `config.js`. There's no backend to run.

**Why Amazon Location Service.** It's the only part of the stack that knows the streets. Isolines answer "what can I reach?" in one call. An API key with a referrer restriction lets a static site use Maps, Places and Routes directly: no Cognito, no Lambda, no server.

**What you can do on it.** A landing page shows the city as 3D towers (height = people, colour = minutes to the nearest hospital). "Play the story" is a 40-second guided tour that walks the worst-served area and the city centre with live Amazon Location data. Then you can explore on your own: click anywhere, search any address, or switch between the six essentials. Every walk has a shareable link.

**What the map reveals.**
- 81% of people have a hospital or clinic within about 15 minutes on foot, 78% a pharmacy, 90% a school, 73% a grocery, but only 49% a park and 55% a station. **Only 29% have all six.**
- In Alinjivakkam, the worst-served area, the real 15-minute walk reaches **none** of the six essentials. The nearest hospital is a **39-minute walk** (2.2 km by street), while in Velachery a clinic is 4 minutes away.
- The gaps aren't in the old city. They're on the edges where Chennai grew fastest: Alinjivakkam, Vadaperumbakkam and Manjampakkam in the north, and Sholinganallur and Nookampalayam along the southern IT corridor.
- Every walk compares the real walking area with the circle that 15 minutes would cover in straight lines at the same pace, so you can see how much of it the streets actually reach.

**The catch (because maps lie quietly).**
- The hexagon colours are an estimate (straight-line × 1.35 detour at 3.5 km/h, calibrated against 35 Amazon Location routes). The click is the ground truth for that spot.
- Overture misses some government health centres and many small shops in India. Roadside bus stops aren't in it at all.
- Reach isn't access. A clinic 5 minutes away can be full, expensive or closed at night.

**Reuse it.** Change one bounding box and one raster tile name and the pipeline rebuilds for any city covered by Overture and HRSL. The pattern works for any "can people reach X?" question: Overture/HRSL on S3 → H3 estimate → Amazon Location isolines on click. The README has the steps.

**Links**
- Live map: http://reachmapbucket.s3-website-us-east-1.amazonaws.com
- Code: https://github.com/MdIbuA/reach-map
- Demo: VIDEO_URL

**AWS services:** Amazon Location Service (Maps, Places Geocode, Routes CalculateIsolines and CalculateRoutes), Amazon S3 (Registry of Open Data on AWS for the data, static website hosting for the site).

---

## Demo video script (target 2:30, hard limit 3:00)

Record the browser at 1440×900 with OBS or the Windows Game Bar (Win+Alt+R), and talk over it. Upload to YouTube as **Unlisted** or Public, *not* Private.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Landing page, 3D city rotating behind it, the counter running up | "This is Chennai, my city. About 1.6 million people here, 1 in 5, live more than a 15-minute walk from a hospital or clinic. This map shows where, and lets anyone check their own street." |
| 0:15–1:00 | Click **Play the story** and let it run through the city flyover and the Alinjivakkam walk | Talk over it: "Every tower is about a tenth of a square kilometre. Height is how many people live there, from the High Resolution Settlement Layer. Colour is the walk to the nearest hospital, from Overture Maps places. Both come from the Registry of Open Data on AWS, read straight from S3." Then, as the walk grows: "Amazon Location Service calculates the real 5, 10 and 15-minute walk from Alinjivakkam. Zero of six essentials. The nearest hospital is a 39-minute walk, 24 minutes over." |
| 1:00–1:30 | The tour moves to Velachery | "Same 15 minutes in Velachery: everything's in reach. The dashed circle is what 15 minutes would cover in a straight line. The streets decide how much of it you actually get." |
| 1:30–2:00 | Skip the tour → type your own area in search → **Walk it** | "You can search any address. That's Amazon Location's Geocode. Here's my own neighbourhood…" (read the score ring and the route time off the card) |
| 2:00–2:25 | Switch the chips (Park → All six), then the 3D/2D toggle; scroll to "The catch" | "Parks are the worst: under half the city has one in walking distance. Only 29% have all six. The page lists its own limits, and the walking model is calibrated against 35 real Amazon Location routes." |
| 2:25–2:40 | Flash the GitHub README, then back to the landing view | "The whole pipeline is on GitHub. Change one bounding box and it runs for your city. How far is help? Now you can check." |

Before you record:
- Do one practice run of the story first so the map tiles are cached and the recording is smooth.
- Pick your own area for the search part, and read the real numbers off the card.
- Close other tabs, zoom the browser to 100% and turn off notifications.
