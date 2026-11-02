# Submission kit: "Map it" weekend challenge

Copy-paste material for the Builder Center form, plus the demo video script.
Replace `LIVE_URL` and `VIDEO_URL` before posting.

---

## Title

How far is help? Chennai on foot

## One-liner

About 988,000 people in and around Chennai live more than a 15-minute walk from a hospital or clinic. Click anywhere on the map and Amazon Location Service draws your real 15-minute walk, then counts what's inside it.

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
4. **AWS Amplify Hosting** builds from GitHub and injects the referrer-restricted Location API key at build time. There's no backend to run.

**Why Amazon Location Service.** It's the only part of the stack that knows the streets. Isolines answer "what can I reach?" in one call. An API key with a referrer restriction lets a static site use Maps, Places and Routes directly: no Cognito, no Lambda, no server.

**What the map reveals.**
- 88% of people have a hospital or clinic within about 15 minutes on foot, 87% a pharmacy, 95% a school, 83% a grocery, but only 66% a park and 71% a station. **Only 52% have all six.**
- The gaps aren't in the old city. They're on the edges where Chennai grew fastest: Alinjivakkam, Vadaperumbakkam and Manjampakkam in the north, and Sholinganallur and Nookampalayam along the southern IT corridor.
- Every walk compares the real walking area with the 1.2 km circle that "15 minutes" would cover in straight lines, so you can see how much of the circle the streets actually reach.

**The catch (because maps lie quietly).**
- The hexagon colours are an estimate (straight-line × 1.35 detour at 4.8 km/h). The click is the ground truth for that spot.
- Overture misses some government health centres and many small shops in India. Roadside bus stops aren't in it at all.
- Reach isn't access. A clinic 5 minutes away can be full, expensive or closed at night.

**Reuse it.** Change one bounding box and one raster tile name and the pipeline rebuilds for any city covered by Overture and HRSL. The pattern works for any "can people reach X?" question: Overture/HRSL on S3 → H3 estimate → Amazon Location isolines on click. The README has the steps.

**Links**
- Live map: LIVE_URL
- Code: https://github.com/MdIbuA/reach-map
- Demo: VIDEO_URL

**AWS services:** Amazon Location Service (Maps, Places Geocode, Routes CalculateIsolines and CalculateRoutes), Amazon S3 via the Registry of Open Data on AWS, AWS Amplify Hosting.

---

## Demo video script (target 2:30, hard limit 3:00)

Record the browser at 1440×900 with OBS or the Windows Game Bar (Win+Alt+R), and talk over it. Upload to YouTube as **Unlisted** or Public, *not* Private.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Landing page, whole city | "This is Chennai, my city. Almost a million people here live more than a 15-minute walk from a hospital or clinic. This map shows where, and lets you check any street yourself." |
| 0:15–0:35 | Hover a few hexagons; switch chips Hospital → Park → All six | "Every hexagon is about a tenth of a square kilometre, with its population from the High Resolution Settlement Layer and its nearest essentials from Overture Maps. Both come from the Registry of Open Data on AWS, read straight from S3. Teal is within 15 minutes, orange is beyond. On 'All six', only half the city has everything." |
| 0:35–1:10 | Click a central spot (for example Mylapore) | "Now the real part. When I click, Amazon Location Service calculates the actual 5, 10 and 15-minute walking areas from this spot. The page counts what's inside: 6 of 6 here. The dashed circle is what 15 minutes *would* cover in straight lines. Real streets reach only this much of it." |
| 1:10–1:50 | "Furthest from a hospital" → tap #1 Alinjivakkam (or Manjampakkam) | "Here's the other end. Out on the edge the walking area is small, and Amazon Location routes me to the nearest clinic: a walk well over 15 minutes. Missing here: …" (read what the card says) |
| 1:50–2:10 | Search "Sholinganallur" → result | "You can search any address. That's Amazon Location Geocode. The IT corridor has offices, but clinics and parks lag behind the people." |
| 2:10–2:30 | Click "Copy link"; scroll to "The catch"; flash the GitHub README | "Every walk has a shareable link. The page lists its own limits: Overture misses some government clinics and bus stops. The whole pipeline is on GitHub. Change one bounding box and it runs for your city." |
| 2:30–2:40 | Back to the city view | "How far is help? Now you can check. Built with Amazon Location Service, S3 open data and Amplify." |

Before you record:
- Click 3–4 spots first and pick the most dramatic contrast (a city-centre spot vs one of the "furthest" areas). Read the real numbers off the card. Don't use the script's placeholders.
- Close other tabs, zoom the browser to 100% and turn off notifications.
