/* How far is help? Chennai on foot.
 *
 * Layers (built offline by pipeline/build_layers.py):
 *   data/hexes.json      H3 res-9 cells: population + straight-line metres to
 *                        the nearest of each essential
 *   data/essentials.json every essential place
 *   data/summary.json    city-wide numbers and the calibrated walking model
 *
 * Live, from Amazon Location Service (API key in config.js):
 *   Maps    dark base map style
 *   Routes  CalculateIsolines (5/10/15-min walking areas) and CalculateRoutes
 *           (walk to the nearest hospital)
 *   Places  Geocode (search box)
 */
(() => {
  "use strict";

  const CFG = Object.assign({ region: "us-east-1", apiKey: "" }, window.REACH_CONFIG || {});
  const HAS_KEY = Boolean(CFG.apiKey);
  const CENTER = [80.215, 13.035];
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MOBILE = () => window.matchMedia("(max-width: 820px)").matches;

  // Calibrated against Amazon Location pedestrian routes (pipeline/calibrate.py);
  // overwritten from data/summary.json on load.
  let WALK_M_PER_MIN = 57.8;
  let CIRCLE_M = 15 * WALK_M_PER_MIN;

  const KIND_COLOURS = ["#ff4d4d", "#d77bff", "#4da3ff", "#ffc23d", "#4ade80", "#22d3ee"];
  const MINUTE_STEPS = [5, 10, 15, 20, 30];
  const MINUTE_COLOURS = ["#0f4c5c", "#16807f", "#3fd5c4", "#ffb347", "#ff6b2c", "#ff2e4d"];
  const COUNT_COLOURS = ["#ff2e4d", "#ff5a36", "#ff8c2c", "#ffc061", "#3fd5c4", "#16a39a", "#0f5f66"];
  const ISO_STYLE = { 900: ["#3fd5c4", 0.16], 600: ["#3fd5c4", 0.2], 300: ["#3fd5c4", 0.28] };
  const HEIGHT = ["interpolate", ["linear"], ["get", "pop"], 0, 0, 1000, 450, 3000, 1100, 6000, 1800];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? Math.min(ms, 50) : ms));

  const state = { mode: "hospital", is3d: true, summary: null, hex: null, ess: null, busy: false, walking: false };

  // ---------- Amazon Location Service ----------

  const api = {
    style() {
      if (!HAS_KEY) {
        return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b0e13" } }] };
      }
      return `https://maps.geo.${CFG.region}.amazonaws.com/v2/styles/Monochrome/descriptor?key=${encodeURIComponent(CFG.apiKey)}&color-scheme=Dark`;
    },
    async post(service, path, body) {
      if (!HAS_KEY) throw new Error("No Amazon Location API key configured");
      const url = `https://${service}.geo.${CFG.region}.amazonaws.com/v2/${path}?key=${encodeURIComponent(CFG.apiKey)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`${service}/${path}: HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
    /** [{seconds, polygons: MultiPolygon coordinates}] */
    async isolines(lonlat) {
      const out = await api.post("routes", "isolines", {
        Origin: lonlat,
        Thresholds: { Time: [300, 600, 900] },
        TravelMode: "Pedestrian",
        IsolineGeometryFormat: "Simple",
      });
      return (out.Isolines || []).map((iso) => ({
        seconds: iso.TimeThreshold,
        polygons: (iso.Geometries || []).map((g) => g.Polygon).filter(Boolean),
      }));
    },
    async route(from, to) {
      const out = await api.post("routes", "routes", {
        Origin: from,
        Destination: to,
        TravelMode: "Pedestrian",
        LegGeometryFormat: "Simple",
      });
      const r = (out.Routes || [])[0];
      if (!r) throw new Error("No route");
      const line = [];
      let dist = 0, dur = 0;
      for (const leg of r.Legs || []) {
        if (leg.Geometry && leg.Geometry.LineString) line.push(...leg.Geometry.LineString);
        const s = leg.PedestrianLegDetails && leg.PedestrianLegDetails.Summary && leg.PedestrianLegDetails.Summary.Overview;
        if (s) { dist += s.Distance || 0; dur += s.Duration || 0; }
      }
      const sum = (r.Summary && r.Summary.Overview) || r.Summary || {};
      return { line, distance: sum.Distance || dist, duration: sum.Duration || dur };
    },
    async geocode(text) {
      const out = await api.post("places", "geocode", {
        QueryText: text,
        BiasPosition: CENTER,
        Filter: { IncludeCountries: ["IND"] },
        MaxResults: 5,
        Language: "en",
      });
      return (out.ResultItems || [])
        .filter((r) => r.Position)
        .map((r) => ({ label: (r.Address && r.Address.Label) || r.Title, lonlat: r.Position }));
    },
  };

  // ---------- geometry ----------

  const LAT0 = (13.04 * Math.PI) / 180;
  const M_PER_DEG_LAT = 111320;
  const M_PER_DEG_LON = 111320 * Math.cos(LAT0);
  const metres = (a, b) => Math.hypot((a[0] - b[0]) * M_PER_DEG_LON, (a[1] - b[1]) * M_PER_DEG_LAT);

  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));
  const inMulti = (pt, polys) => polys.some((p) => inPolygon(pt, p));

  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * M_PER_DEG_LON * ring[i][1] * M_PER_DEG_LAT - ring[i][0] * M_PER_DEG_LON * ring[j][1] * M_PER_DEG_LAT;
    }
    return Math.abs(a / 2);
  }
  const multiArea = (polys) => polys.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);

  function circle(center, radius, n = 96) {
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      ring.push([center[0] + (radius * Math.cos(t)) / M_PER_DEG_LON, center[1] + (radius * Math.sin(t)) / M_PER_DEG_LAT]);
    }
    return [[ring]];
  }

  function bboxOf(polys) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of polys) for (const [x, y] of p[0]) {
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    return b;
  }

  // ---------- data ----------

  async function loadData() {
    const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
    const [summary, hex, ess] = await Promise.all([get("summary.json"), get("hexes.json"), get("essentials.json")]);
    state.summary = summary; state.hex = hex; state.ess = ess;
    state.kinds = summary.essentials;
    state.detour = summary.detour;
    WALK_M_PER_MIN = summary.walk_m_per_min;
    CIRCLE_M = 15 * WALK_M_PER_MIN;
    state.cellIndex = new Map(hex.cells.map((c, i) => [c[0], i]));
  }

  const crowToMinutes = (m) => (m * state.detour) / WALK_M_PER_MIN;
  const kindIndex = (key) => state.kinds.findIndex((k) => k.key === key);

  function hexGeoJSON() {
    const k = state.kinds.length;
    const reach = state.summary.reach_crow_m;
    const features = state.hex.cells.map((c) => {
      const props = { pop: c[1], area: state.hex.areas[c[2 + k]][0] };
      let n = 0;
      for (let i = 0; i < k; i++) {
        props["m" + i] = Math.round(crowToMinutes(c[2 + i]) * 10) / 10;
        if (c[2 + i] <= reach) n++;
      }
      props.n = n;
      return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [h3.cellToBoundary(c[0], true)] } };
    });
    return { type: "FeatureCollection", features };
  }

  function placesGeoJSON(list) {
    return {
      type: "FeatureCollection",
      features: list.map((p) => ({ type: "Feature", properties: { kind: p[2], name: p[3] }, geometry: { type: "Point", coordinates: [p[0], p[1]] } })),
    };
  }

  // ---------- map ----------

  const map = new maplibregl.Map({
    container: "map",
    style: api.style(),
    center: [80.2, 13.0],
    zoom: 9.2,
    pitch: 0,
    bearing: 0,
    minZoom: 8.5,
    maxZoom: 17,
    maxPitch: 70,
    attributionControl: false,
    cooperativeGestures: MOBILE(),
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: "Places © Overture Maps Foundation · Population © Meta & CIESIN HRSL (CC BY 4.0)",
  }));

  if (!HAS_KEY) {
    const note = $("map-note");
    note.hidden = false;
    note.textContent = "No Amazon Location API key configured: no base map, and walks fall back to a straight-line estimate.";
  }

  function hexColour() {
    if (state.mode === "all") {
      const e = ["match", ["get", "n"]];
      COUNT_COLOURS.forEach((c, i) => e.push(i, c));
      e.push("#555");
      return e;
    }
    const e = ["step", ["get", "m" + kindIndex(state.mode)], MINUTE_COLOURS[0]];
    MINUTE_STEPS.forEach((s, i) => e.push(s, MINUTE_COLOURS[i + 1]));
    return e;
  }

  const placesFilter = () => (state.mode === "all" ? true : ["==", ["get", "kind"], kindIndex(state.mode)]);

  function kindColourExpr() {
    const e = ["match", ["get", "kind"]];
    KIND_COLOURS.forEach((c, i) => e.push(i, c));
    e.push("#aaa");
    return e;
  }

  function firstSymbolLayer() {
    const l = (map.getStyle().layers || []).find((x) => x.type === "symbol");
    return l && l.id;
  }

  function addLayers() {
    const before = firstSymbolLayer();
    map.addSource("hex", { type: "geojson", data: hexGeoJSON() });
    map.addLayer({
      id: "hex", type: "fill-extrusion", source: "hex",
      paint: {
        "fill-extrusion-color": hexColour(),
        "fill-extrusion-height": state.is3d ? HEIGHT : 0,
        "fill-extrusion-opacity": 0.86,
        "fill-extrusion-vertical-gradient": true,
        "fill-extrusion-height-transition": { duration: REDUCED ? 0 : 1200, delay: 0 },
      },
    }, before);

    map.addSource("places", { type: "geojson", data: placesGeoJSON(state.ess.places) });
    map.addLayer({
      id: "places-glow", type: "circle", source: "places", minzoom: 12, filter: placesFilter(),
      paint: { "circle-color": kindColourExpr(), "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 6, 16, 14], "circle-blur": 1, "circle-opacity": 0.45 },
    });
    map.addLayer({
      id: "places", type: "circle", source: "places", minzoom: 12, filter: placesFilter(),
      paint: { "circle-color": kindColourExpr(), "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 16, 5], "circle-stroke-color": "#0b0d12", "circle-stroke-width": 1 },
    });

    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["iso", "circle", "route", "inside"]) map.addSource(id, { type: "geojson", data: empty, lineMetrics: id === "route" });
    map.addLayer({ id: "iso-fill", type: "fill", source: "iso", paint: { "fill-color": ["get", "colour"], "fill-opacity": ["get", "opacity"] } });
    map.addLayer({ id: "iso-glow", type: "line", source: "iso", paint: { "line-color": "#3fd5c4", "line-width": 8, "line-blur": 6, "line-opacity": ["case", ["==", ["get", "seconds"], 900], 0.55, 0] } });
    map.addLayer({ id: "iso-line", type: "line", source: "iso", paint: { "line-color": "#7ff5e6", "line-width": ["case", ["==", ["get", "seconds"], 900], 2.2, 0.8], "line-opacity": 0.95 } });
    map.addLayer({ id: "circle-line", type: "line", source: "circle", paint: { "line-color": "#c7ced8", "line-width": 1.3, "line-dasharray": [2, 2], "line-opacity": 0.7 } });
    map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ff4fa3", "line-width": 12, "line-blur": 8, "line-opacity": 0.6 } });
    map.addLayer({
      id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-width": 4, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#ffffff", 0.25, "#ff4fa3", 1, "#ff2e4d"] },
    });
    map.addLayer({ id: "inside-glow", type: "circle", source: "inside", paint: { "circle-color": kindColourExpr(), "circle-radius": 10, "circle-blur": 1, "circle-opacity": 0.5 } });
    map.addLayer({ id: "inside", type: "circle", source: "inside", paint: { "circle-color": kindColourExpr(), "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 16, 6.5], "circle-stroke-color": "#0b0d12", "circle-stroke-width": 1.5 } });
  }

  function setMode(mode) {
    state.mode = mode;
    for (const b of $("chips").children) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    if (map.getLayer("hex")) {
      map.setPaintProperty("hex", "fill-extrusion-color", hexColour());
      map.setFilter("places", placesFilter());
      map.setFilter("places-glow", placesFilter());
    }
    renderLegend();
  }

  function setHeights() {
    const tall = state.is3d && !state.walking;
    map.setPaintProperty("hex", "fill-extrusion-height", tall ? HEIGHT : 0);
    map.setPaintProperty("hex", "fill-extrusion-opacity", state.walking ? 0.2 : 0.86);
  }

  function set3d(on) {
    state.is3d = on;
    $("dim-toggle").setAttribute("aria-pressed", String(on));
    $("dim-toggle").textContent = on ? "3D" : "2D";
    setHeights();
    if (!state.walking) map.easeTo({ pitch: on ? 52 : 0, bearing: on ? -18 : 0, duration: REDUCED ? 0 : 1200 });
  }

  // ---------- hover ----------

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px", offset: 12 });
  function onHover(e) {
    const f = e.features && e.features[0];
    if (!f || MOBILE()) return;
    const p = f.properties;
    let html;
    if (f.layer.id === "hex") {
      const line = state.mode === "all"
        ? `<span class="ph">${p.n}/6</span> essentials within ~15 min`
        : `<span class="ph">~${Math.round(p["m" + kindIndex(state.mode)])} min</span> to the nearest ${esc(state.kinds[kindIndex(state.mode)].label.toLowerCase())}`;
      html = `<div class="pm">${esc(p.area)} · ~${fmt(p.pop)} people</div><div>${line}</div><div class="pm">Estimate · click to walk it for real</div>`;
    } else {
      html = `<b>${esc(p.name)}</b><div class="pm">${esc(state.kinds[p.kind].label)}</div>`;
    }
    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
  }

  // ---------- the walk ----------

  function nearestArea(lonlat) {
    const i = state.cellIndex.get(h3.latLngToCell(lonlat[1], lonlat[0], state.summary.h3_resolution));
    if (i !== undefined) return state.hex.areas[state.hex.cells[i][2 + state.kinds.length]][0];
    let best = "Chennai", bd = Infinity;
    for (const a of state.hex.areas) {
      const d = metres(lonlat, [a[1], a[2]]);
      if (d < bd) { bd = d; best = a[0]; }
    }
    return best;
  }

  function nearestOfKind(lonlat, kind) {
    let best = null, bd = Infinity;
    for (const p of state.ess.places) {
      if (p[2] !== kind) continue;
      const d = metres(lonlat, p);
      if (d < bd) { bd = d; best = p; }
    }
    return best && { place: best, metres: bd };
  }

  /** Fly to a bbox with a gentle tilt, keeping it clear of the floating panel. */
  function frame(b, duration) {
    const pad = MOBILE() ? { top: 24, bottom: 24, left: 24, right: 24 } : { top: 90, bottom: 90, left: 480, right: 90 };
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    map.setPadding(none);
    const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, bearing: 0 });
    if (!cam) return;
    map.flyTo({ center: cam.center, zoom: Math.min(15.5, cam.zoom - 0.25), pitch: 38, bearing: -12, padding: none, duration: REDUCED ? 0 : duration, essential: true });
  }

  let marker = null;
  function placeMarker(lonlat) {
    if (!marker) {
      const el = document.createElement("div");
      el.className = "origin-marker";
      marker = new maplibregl.Marker({ element: el });
    }
    marker.setLngLat(lonlat).addTo(map);
  }

  async function animateRoute(line) {
    const src = map.getSource("route");
    if (REDUCED || line.length < 3) {
      src.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
      return;
    }
    const total = 1400, t0 = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / total);
        const eased = 1 - Math.pow(1 - t, 3);
        const n = Math.max(2, Math.ceil(eased * line.length));
        src.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.slice(0, n) } });
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }

  function ringSVG(have) {
    const r = 36, c = 2 * Math.PI * r;
    const colour = have >= 5 ? "#3fd5c4" : have >= 3 ? "#ffb347" : "#ff4d4d";
    return `<div class="ring" style="color:${colour}">
      <svg viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="${r}" fill="none" stroke-width="7"/>
      <circle class="val" cx="42" cy="42" r="${r}" fill="none" stroke="${colour}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - have / 6)}"/></svg>
      <div class="num">${have}<small>OF 6</small></div></div>`;
  }

  async function analyse(lonlat, label) {
    if (state.busy) return;
    state.busy = true;
    state.walking = true;
    popup.remove();
    lonlat = [Number(lonlat[0].toFixed(5)), Number(lonlat[1].toFixed(5))];
    const area = label || nearestArea(lonlat);
    history.replaceState(null, "", `#@${lonlat[1].toFixed(5)},${lonlat[0].toFixed(5)}`);

    const box = $("result");
    box.hidden = false;
    box.className = "result loading";
    box.innerHTML = `<p class="r-eyebrow">Walking out from</p><h3>${esc(area)}</h3><p class="verdict">Asking Amazon Location Service for the real 5, 10 and 15-minute walks…</p><div class="scan"></div>`;
    $("panel").scrollTo({ top: box.offsetTop - 12, behavior: REDUCED ? "auto" : "smooth" });

    setHeights();
    placeMarker(lonlat);
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["iso", "route", "inside"]) map.getSource(id).setData(empty);
    map.getSource("circle").setData({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: circle(lonlat, CIRCLE_M) } });
    const preview = circle(lonlat, CIRCLE_M * 1.15)[0][0];
    const pb = bboxOf([[preview]]);
    frame(pb, 1600);

    let isos, isoError = null;
    try {
      isos = await api.isolines(lonlat);
      if (!isos.length || !isos.some((i) => i.polygons.length)) throw new Error("Empty isoline");
    } catch (err) {
      isoError = err;
      console.warn("Isolines unavailable, using straight-line estimate:", err);
      const r = state.summary.reach_crow_m;
      isos = [300, 600, 900].map((s) => ({ seconds: s, polygons: circle(lonlat, (r * s) / 900) }));
    }

    // Grow the walk outward: 5, then 10, then 15 minutes.
    const shown = [];
    for (const s of [300, 600, 900]) {
      const iso = isos.find((i) => i.seconds === s);
      if (!iso) continue;
      shown.unshift(iso);
      map.getSource("iso").setData({
        type: "FeatureCollection",
        features: shown.map((i) => ({
          type: "Feature",
          properties: { seconds: i.seconds, colour: ISO_STYLE[i.seconds][0], opacity: ISO_STYLE[i.seconds][1] },
          geometry: { type: "MultiPolygon", coordinates: i.polygons },
        })),
      });
      await sleep(380);
    }

    const walk15 = (isos.find((i) => i.seconds === 900) || isos[0]).polygons;
    const [x0, y0, x1, y1] = bboxOf(walk15);
    const inside = state.ess.places.filter((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inMulti(p, walk15));
    const inCircle = state.ess.places.filter((p) => metres(lonlat, p) <= CIRCLE_M).length;
    map.getSource("inside").setData(placesGeoJSON(inside));

    const counts = state.kinds.map((_, k) => inside.filter((p) => p[2] === k).length);
    const missing = state.kinds.filter((_, k) => counts[k] === 0).map((k) => k.label.toLowerCase());
    const have = counts.filter((c) => c > 0).length;

    // Walk to the nearest hospital or clinic.
    const near = nearestOfKind(lonlat, 0);
    let routeHtml = "";
    let routeLine = null;
    if (near) {
      const name = esc(near.place[3]);
      try {
        if (isoError) throw isoError;
        const r = await api.route(lonlat, [near.place[0], near.place[1]]);
        routeLine = r.line;
        const mins = Math.round(r.duration / 60);
        routeHtml = `<div class="route-box"><div class="mins">${mins}<small>min</small></div>
          <div class="r1">walk to the nearest hospital or clinic${mins > 15 ? `<span class="over">+${mins - 15} over</span>` : ""}</div>
          <div class="r2">${name} · ${(r.distance / 1000).toFixed(1)} km by street</div></div>`;
      } catch {
        const mins = Math.round(crowToMinutes(near.metres));
        routeHtml = `<div class="route-box"><div class="mins">~${mins}<small>min</small></div>
          <div class="r1">to the nearest hospital or clinic (estimate)</div><div class="r2">${name}</div></div>`;
      }
    }

    const pct = Math.round((multiArea(walk15) / (Math.PI * CIRCLE_M * CIRCLE_M)) * 100);
    const compare = isoError
      ? `<p class="est-note">${HAS_KEY ? "Couldn't reach Amazon Location Service just now" : "No Amazon Location API key configured"}, so these rings are a straight-line estimate, not real streets.</p>`
      : `<div class="compare"><div class="c-row"><span>Streets reach <b>${Math.min(pct, 999)}%</b> of the straight-line circle</span><span><b>${inside.length}</b> of ${inCircle} places</span></div>
         <div class="c-bar"><span style="width:0" data-w="${Math.min(100, pct)}%"></span></div>
         <p>The dashed circle is how far ${(CIRCLE_M / 1000).toFixed(2)} km, a 15-minute walk, would take you in a straight line. Rivers, railways and dead ends decide the rest.</p></div>`;

    const tiles = state.kinds.map((k, i) => {
      const n = nearestOfKind(lonlat, i);
      const est = n ? `nearest ~${Math.round(crowToMinutes(n.metres))} min` : "";
      return `<div class="tile ${counts[i] ? "" : "zero"}" style="animation-delay:${i * 60}ms"><div class="t-count"><i style="background:${KIND_COLOURS[i]};color:${KIND_COLOURS[i]}"></i>${counts[i]}</div><div class="t-label">${esc(k.label)}</div><div class="t-near">${est}</div></div>`;
    }).join("");

    box.className = "result" + (have <= 3 ? " bad" : "");
    box.innerHTML = `
      <div class="r-top">
        <div><p class="r-eyebrow">${isoError ? "Estimated" : "Real"} 15-minute walk from</p><h3>${esc(area)}</h3>
        <p class="verdict">${have === 6 ? "<b>Everything's in reach.</b>" : `Missing: <b>${esc(missing.join(", "))}</b>.`}</p></div>
        ${ringSVG(have)}
      </div>
      <div class="tiles">${tiles}</div>
      ${routeHtml}
      ${compare}
      <div class="legend-key"><span class="k-walk">${isoError ? "estimated" : "real"} walk 5·10·15 min</span><span class="k-circle">straight-line circle</span><span class="k-route">route</span></div>
      <div class="r-actions"><button type="button" class="btn btn-ghost" id="copy-link">Copy link to this walk</button><button type="button" class="btn btn-ghost" id="clear">Back to the city</button></div>`;
    requestAnimationFrame(() => {
      const v = box.querySelector(".ring .val"); if (v) v.style.strokeDashoffset = v.dataset.target;
      const b = box.querySelector(".c-bar span"); if (b) b.style.width = b.dataset.w;
    });
    $("copy-link").onclick = async (ev) => {
      try { await navigator.clipboard.writeText(location.href); ev.target.textContent = "Link copied"; } catch { ev.target.textContent = location.href; }
    };
    $("clear").onclick = clearWalk;

    const fb = [Math.min(x0, lonlat[0] - 0.006), Math.min(y0, lonlat[1] - 0.006), Math.max(x1, lonlat[0] + 0.006), Math.max(y1, lonlat[1] + 0.006)];
    if (routeLine) for (const [x, y] of routeLine) { fb[0] = Math.min(fb[0], x); fb[1] = Math.min(fb[1], y); fb[2] = Math.max(fb[2], x); fb[3] = Math.max(fb[3], y); }
    frame(fb, 1100);
    if (routeLine) await animateRoute(routeLine);
    state.busy = false;
  }

  function clearWalk() {
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["iso", "circle", "route", "inside"]) map.getSource(id).setData(empty);
    if (marker) marker.remove();
    $("result").hidden = true;
    state.walking = false;
    setHeights();
    history.replaceState(null, "", location.pathname);
    flyHome();
  }

  function flyHome(duration = 1600) {
    map.flyTo({ center: CENTER, zoom: MOBILE() ? 9.9 : 10.55, pitch: state.is3d ? 52 : 0, bearing: state.is3d ? -18 : 0, padding: MOBILE() ? {} : { left: 440 }, duration: REDUCED ? 0 : duration, essential: true });
  }

  // ---------- panel ----------

  function renderChips() {
    const chips = $("chips");
    const make = (mode, label, colour) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.mode = mode;
      b.setAttribute("role", "radio");
      b.innerHTML = (colour ? `<i style="background:${colour};color:${colour}"></i>` : "") + esc(label);
      b.onclick = () => setMode(mode);
      chips.appendChild(b);
    };
    make("all", "All six", "");
    state.kinds.forEach((k, i) => make(k.key, k.label, KIND_COLOURS[i]));
  }

  function renderLegend() {
    const lg = $("legend");
    if (state.mode === "all") {
      lg.innerHTML = `<div class="ramp">${COUNT_COLOURS.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="labels"><span>0 of 6</span><span>essentials within a ~15-min walk</span><span><b>6 of 6</b></span></div>`;
    } else {
      lg.innerHTML = `<div class="ramp">${MINUTE_COLOURS.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="labels"><span>5</span><span>10</span><span><b>15 min</b></span><span>20</span><span>30</span><span>30+</span></div>`;
    }
  }

  function countUp(el, target, ms = 1800) {
    if (REDUCED) { el.textContent = fmt(target); return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(target * (1 - Math.pow(1 - t, 4)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderFindings() {
    const s = state.summary;
    countUp($("stat-no-hospital"), Math.round(s.people_no_hospital / 1000) * 1000);
    $("bars").innerHTML = state.kinds.map((k, i) => {
      const v = s.share_within_reach[k.key];
      return `<div class="bar"><span>${esc(k.label)}</span><span class="pct">${Math.round(v * 100)}%</span><span class="track"><span class="fill" data-w="${(v * 100).toFixed(1)}%" style="transition-delay:${i * 90}ms"></span></span></div>`;
    }).join("");
    requestAnimationFrame(() => setTimeout(() => {
      for (const f of $("bars").querySelectorAll(".fill")) f.style.width = f.dataset.w;
    }, 300));
    $("all-six").innerHTML = `Share of ${fmt(s.population)} people with each essential within ~15 minutes on foot. Only <b>${Math.round(s.share_all_six * 100)}%</b> have all six.`;
    const max = s.worst_areas_for_hospital[0].people_beyond;
    $("worst").innerHTML = s.worst_areas_for_hospital.map((w, i) =>
      `<li><button type="button" data-i="${i}"><span>${esc(w.name)}</span><span class="n">${fmt(w.people_beyond)}</span><span class="heat" style="width:${(w.people_beyond / max) * 100}%"></span></button></li>`).join("");
    for (const b of $("worst").querySelectorAll("button")) {
      b.onclick = () => {
        const w = s.worst_areas_for_hospital[Number(b.dataset.i)];
        analyse([w.lon, w.lat], w.name);
      };
    }
  }

  // ---------- story tour ----------

  const tour = { on: false, i: 0, next: null };
  function tourSteps() {
    const s = state.summary;
    const worst = s.worst_areas_for_hospital[0];
    return [
      {
        text: `This is Chennai: <b>${(s.population / 1e6).toFixed(1)} million people</b>, mapped in ${fmt(s.cells)} hexagons. Each tower's <span class="cool">height</span> is how many people live there.`,
        run: async () => { setMode("hospital"); state.walking = false; setHeights(); map.flyTo({ center: CENTER, zoom: MOBILE() ? 9.9 : 10.6, pitch: 58, bearing: -28, padding: MOBILE() ? {} : { left: 440 }, duration: REDUCED ? 0 : 3000 }); },
        ms: 6500,
      },
      {
        text: `Colour is the walk to the nearest hospital or clinic. <span class="cool">Teal</span> is under 15 minutes. <b>Orange and red</b> is more: that's <b>${fmt(Math.round(s.people_no_hospital / 1000) * 1000)} people</b>.`,
        run: async () => { map.easeTo({ bearing: 12, pitch: 55, duration: REDUCED ? 0 : 6000 }); },
        ms: 6500,
      },
      {
        text: `The gaps are on the edges where the city grew fastest. Take <b>${esc(worst.name)}</b>: ${fmt(worst.people_beyond)} people. Here's the real 15-minute walk from Amazon Location Service.`,
        run: async () => { await analyse([worst.lon, worst.lat], worst.name); },
        ms: 9000,
      },
      {
        text: `Now the city centre. <b>Velachery</b>: same 15 minutes, a very different answer.`,
        run: async () => { await analyse([80.2185, 12.9794], "Velachery"); },
        ms: 9000,
      },
      {
        text: `Only <b>${Math.round(s.share_all_six * 100)}%</b> of Chennai can walk to all six essentials. <span class="cool">Search your street, or click anywhere,</span> to see yours.`,
        run: async () => { clearWalk(); },
        ms: 7000,
      },
    ];
  }

  async function playTour() {
    if (tour.on) return;
    tour.on = true;
    document.body.classList.add("touring");
    $("tour").hidden = false;
    const steps = tourSteps();
    $("tour-steps").innerHTML = steps.map(() => "<span></span>").join("");
    for (tour.i = 0; tour.i < steps.length && tour.on; tour.i++) {
      const st = steps[tour.i];
      [...$("tour-steps").children].forEach((el, j) => { el.className = j < tour.i ? "done" : ""; });
      $("tour-text").innerHTML = st.text;
      $("tour-next").textContent = tour.i === steps.length - 1 ? "Explore" : "Next";
      await st.run();
      if (!tour.on) break;
      const bar = $("tour-steps").children[tour.i];
      bar.style.setProperty("--dur", `${st.ms}ms`);
      bar.className = "now";
      await new Promise((r) => { tour.next = r; setTimeout(r, st.ms); });
    }
    endTour();
  }
  function endTour() {
    tour.on = false;
    if (tour.next) tour.next();
    document.body.classList.remove("touring");
    $("tour").hidden = true;
  }
  $("tour-btn").onclick = playTour;
  $("tour-next").onclick = () => { if (tour.next) tour.next(); };
  $("tour-skip").onclick = endTour;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tour.on) endTour(); });

  // ---------- search ----------

  function localSearch(q) {
    q = q.toLowerCase();
    return state.hex.areas.filter((a) => a[0].toLowerCase().includes(q)).slice(0, 5)
      .map((a) => ({ label: `${a[0]}, Chennai`, lonlat: [a[1], a[2]] }));
  }

  $("search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    const list = $("search-results");
    if (!q) return;
    let results = [];
    try { results = await api.geocode(/chennai/i.test(q) ? q : `${q}, Chennai`); } catch (err) { console.warn(err); }
    if (!results.length) results = localSearch(q);
    list.innerHTML = results.length
      ? results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.label)}</button></li>`).join("")
      : `<li><button type="button" disabled>No match. Try a neighbourhood name.</button></li>`;
    list.hidden = false;
    for (const b of list.querySelectorAll("button[data-i]")) {
      b.onclick = () => {
        list.hidden = true;
        const r = results[Number(b.dataset.i)];
        analyse(r.lonlat, r.label.split(",")[0]);
      };
    }
  });
  document.addEventListener("click", (e) => { if (!$("search").contains(e.target)) $("search-results").hidden = true; });

  // ---------- boot ----------

  const dataReady = loadData();
  map.on("load", async () => {
    await dataReady;
    renderChips();
    setMode("hospital");
    renderFindings();
    addLayers();
    $("dim-toggle").onclick = () => set3d(!state.is3d);
    $("show-places").onchange = (e) => {
      for (const id of ["places", "places-glow"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
    };
    for (const id of ["hex", "places"]) {
      map.on("mousemove", id, onHover);
      map.on("mouseleave", id, () => popup.remove());
    }
    map.on("click", (e) => { if (!tour.on) analyse([e.lngLat.lng, e.lngLat.lat]); });
    const m = location.hash.match(/^#@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) analyse([Number(m[2]), Number(m[1])]);
    else flyHome(2600);
    const attrib = document.querySelector(".maplibregl-ctrl-attrib");
    if (attrib && MOBILE()) attrib.classList.remove("maplibregl-compact-show");
    window.__reachReady = true;
  });
  dataReady.catch((err) => {
    $("panel").insertAdjacentHTML("afterbegin", `<p class="small" style="color:#ff5a36">Couldn't load the map data (${esc(err.message)}). Try reloading.</p>`);
  });
})();
