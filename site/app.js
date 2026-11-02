/* How far is help? Chennai on foot.
 *
 * Layers (built offline by pipeline/build_layers.py):
 *   data/hexes.json      H3 res-9 cells: population + straight-line metres to
 *                        the nearest of each essential
 *   data/essentials.json every essential place
 *   data/summary.json    city-wide numbers
 *
 * Live, from Amazon Location Service (API key in config.js):
 *   Maps    base map style
 *   Routes  CalculateIsolines (5/10/15-min walking areas) and CalculateRoutes
 *           (walk to the nearest hospital)
 *   Places  Geocode (search box)
 */
(() => {
  "use strict";

  const CFG = Object.assign({ region: "us-east-1", apiKey: "" }, window.REACH_CONFIG || {});
  const HAS_KEY = Boolean(CFG.apiKey);
  const CENTER = [80.235, 13.04];
  const WALK_M_PER_MIN = 80; // 4.8 km/h
  const CIRCLE_M = 15 * WALK_M_PER_MIN; // what "15 minutes" covers if streets were straight

  const KIND_COLOURS = ["#dc2626", "#a21caf", "#2563eb", "#ca8a04", "#15803d", "#0891b2"];
  const MINUTE_STEPS = [5, 10, 15, 20, 30];
  const MINUTE_COLOURS = ["#115e59", "#14b8a6", "#99f6e4", "#fdba74", "#f97316", "#9a3412"];
  const COUNT_COLOURS = ["#7c2d12", "#c2410c", "#f97316", "#fed7aa", "#99f6e4", "#2dd4bf", "#0f766e"];
  const HEX_OPACITY = ["interpolate", ["linear"], ["get", "pop"], 0, 0.25, 400, 0.72];
  const ISO_STYLE = { 900: ["#99f6e4", 0.35], 600: ["#2dd4bf", 0.35], 300: ["#0f766e", 0.35] };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  const state = { mode: "hospital", summary: null, hex: null, ess: null, busy: false, last: null };

  // ---------- Amazon Location Service ----------

  const api = {
    style() {
      if (!HAS_KEY) {
        return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ecea" } }] };
      }
      return `https://maps.geo.${CFG.region}.amazonaws.com/v2/styles/Monochrome/descriptor?key=${encodeURIComponent(CFG.apiKey)}&color-scheme=Light`;
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
    /** Returns [{seconds, rings: [[ [lon,lat]... ], ...] (MultiPolygon coords)}] */
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

  // ---------- geometry helpers ----------

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

  function circle(center, radius, n = 72) {
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
    state.cellIndex = new Map(hex.cells.map((c, i) => [c[0], i]));
  }

  const crowToMinutes = (m) => (m * state.detour) / WALK_M_PER_MIN;

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
      return {
        type: "Feature",
        properties: props,
        geometry: { type: "Polygon", coordinates: [h3.cellToBoundary(c[0], true)] },
      };
    });
    return { type: "FeatureCollection", features };
  }

  function placesGeoJSON(filterFn) {
    return {
      type: "FeatureCollection",
      features: state.ess.places.filter(filterFn || (() => true)).map((p) => ({
        type: "Feature",
        properties: { kind: p[2], name: p[3] },
        geometry: { type: "Point", coordinates: [p[0], p[1]] },
      })),
    };
  }

  // ---------- map ----------

  const map = new maplibregl.Map({
    container: "map",
    style: api.style(),
    center: CENTER,
    zoom: 10.6,
    minZoom: 9,
    maxZoom: 17,
    attributionControl: false,
    cooperativeGestures: window.matchMedia("(max-width: 820px)").matches,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: "Places © Overture Maps Foundation · Population © Meta & CIESIN HRSL (CC BY 4.0)",
  }));
  map.addControl(new maplibregl.GeolocateControl({ showUserLocation: true }), "top-right");

  if (!HAS_KEY) {
    const note = $("map-note");
    note.hidden = false;
    note.textContent = "Running without an Amazon Location API key: no base map, and walking areas fall back to a straight-line estimate.";
  }

  function hexColour() {
    if (state.mode === "all") {
      const e = ["match", ["get", "n"]];
      COUNT_COLOURS.forEach((c, i) => e.push(i, c));
      e.push("#999");
      return e;
    }
    const idx = state.kinds.findIndex((k) => k.key === state.mode);
    const e = ["step", ["get", "m" + idx], MINUTE_COLOURS[0]];
    MINUTE_STEPS.forEach((s, i) => e.push(s, MINUTE_COLOURS[i + 1]));
    return e;
  }

  function placesFilter() {
    if (state.mode === "all") return true;
    return ["==", ["get", "kind"], state.kinds.findIndex((k) => k.key === state.mode)];
  }

  function kindColourExpr() {
    const e = ["match", ["get", "kind"]];
    KIND_COLOURS.forEach((c, i) => e.push(i, c));
    e.push("#444");
    return e;
  }

  function firstSymbolLayer() {
    const layers = map.getStyle().layers || [];
    const l = layers.find((x) => x.type === "symbol");
    return l && l.id;
  }

  function addLayers() {
    const before = firstSymbolLayer();
    map.addSource("hex", { type: "geojson", data: hexGeoJSON() });
    map.addLayer({
      id: "hex-fill", type: "fill", source: "hex",
      paint: {
        "fill-color": hexColour(),
        "fill-opacity": HEX_OPACITY,
      },
    }, before);
    map.addLayer({
      id: "hex-line", type: "line", source: "hex", minzoom: 12.5,
      paint: { "line-color": "#ffffff", "line-width": 0.4, "line-opacity": 0.6 },
    }, before);

    map.addSource("places", { type: "geojson", data: placesGeoJSON() });
    map.addLayer({
      id: "places", type: "circle", source: "places", minzoom: 12,
      filter: placesFilter(),
      paint: {
        "circle-color": kindColourExpr(),
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 6],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1,
      },
    });

    // Walk analysis layers.
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["iso", "circle", "route", "inside", "origin"]) map.addSource(id, { type: "geojson", data: empty });
    map.addLayer({
      id: "iso-fill", type: "fill", source: "iso",
      paint: { "fill-color": ["get", "colour"], "fill-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "iso-line", type: "line", source: "iso",
      paint: { "line-color": "#0f766e", "line-width": ["case", ["==", ["get", "seconds"], 900], 2.5, 1] },
    });
    map.addLayer({
      id: "circle-line", type: "line", source: "circle",
      paint: { "line-color": "#57534e", "line-width": 1.5, "line-dasharray": [3, 2] },
    });
    map.addLayer({
      id: "route-line", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#db2777", "line-width": 4 },
    });
    map.addLayer({
      id: "inside", type: "circle", source: "inside",
      paint: {
        "circle-color": kindColourExpr(),
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 16, 7],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "origin", type: "circle", source: "origin",
      paint: { "circle-color": "#1c1917", "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
    });
  }

  function setMode(mode) {
    state.mode = mode;
    for (const b of $("chips").children) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    if (map.getLayer("hex-fill")) {
      map.setPaintProperty("hex-fill", "fill-color", hexColour());
      map.setFilter("places", placesFilter());
    }
    renderLegend();
  }

  // ---------- hover ----------

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
  function onHover(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    let html;
    if (f.layer.id === "hex-fill") {
      const line = state.mode === "all"
        ? `<b>${p.n} of 6</b> essentials within ~15 min`
        : `Nearest ${esc(state.kinds.find((k) => k.key === state.mode).label.toLowerCase())}: <b>~${Math.round(p["m" + state.kinds.findIndex((k) => k.key === state.mode)])} min</b> walk`;
      html = `<div>${esc(p.area)}</div><div>~${fmt(p.pop)} people here</div><div>${line}</div><div style="color:#78716c">Estimate. Click to walk it for real.</div>`;
    } else {
      html = `<b>${esc(p.name)}</b><br>${esc(state.kinds[p.kind].label)}`;
    }
    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
  }

  // ---------- the walk ----------

  function nearestArea(lonlat) {
    const cell = h3.latLngToCell(lonlat[1], lonlat[0], state.summary.h3_resolution);
    const i = state.cellIndex.get(cell);
    const k = state.kinds.length;
    if (i !== undefined) return state.hex.areas[state.hex.cells[i][2 + k]][0];
    let best = null, bd = Infinity;
    for (const a of state.hex.areas) {
      const d = metres(lonlat, [a[1], a[2]]);
      if (d < bd) { bd = d; best = a[0]; }
    }
    return best || "Chennai";
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

  async function analyse(lonlat, label) {
    if (state.busy) return;
    state.busy = true;
    lonlat = [Number(lonlat[0].toFixed(5)), Number(lonlat[1].toFixed(5))];
    const area = label || nearestArea(lonlat);
    history.replaceState(null, "", `#@${lonlat[1].toFixed(5)},${lonlat[0].toFixed(5)}`);
    $("hint").hidden = true;
    map.setPaintProperty("hex-fill", "fill-opacity", 0.18);

    const box = $("result");
    box.hidden = false;
    box.classList.add("loading");
    box.innerHTML = `<h3>Walking out from ${esc(area)}…</h3><p class="where">Asking Amazon Location Service for the 5, 10 and 15-minute walking areas.</p>`;
    map.getSource("origin").setData({ type: "Feature", geometry: { type: "Point", coordinates: lonlat }, properties: {} });
    map.getSource("circle").setData({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: circle(lonlat, CIRCLE_M) } });
    map.getSource("route").setData({ type: "FeatureCollection", features: [] });

    let isos = null, isoError = null;
    try {
      isos = await api.isolines(lonlat);
      if (!isos.length || !isos.some((i) => i.polygons.length)) throw new Error("Empty isoline");
    } catch (err) {
      isoError = err;
      console.warn("Isolines unavailable, using straight-line estimate:", err);
      const r = state.summary.reach_crow_m;
      isos = [300, 600, 900].map((s) => ({ seconds: s, polygons: circle(lonlat, (r * s) / 900) }));
    }
    isos.sort((a, b) => b.seconds - a.seconds);
    map.getSource("iso").setData({
      type: "FeatureCollection",
      features: isos.map((i) => ({
        type: "Feature",
        properties: { seconds: i.seconds, colour: ISO_STYLE[i.seconds][0], opacity: ISO_STYLE[i.seconds][1] },
        geometry: { type: "MultiPolygon", coordinates: i.polygons },
      })),
    });

    const walk15 = isos.find((i) => i.seconds === 900).polygons;
    const [x0, y0, x1, y1] = bboxOf(walk15);
    const inside = state.ess.places.filter((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inMulti(p, walk15));
    const inCircle = state.ess.places.filter((p) => metres(lonlat, p) <= CIRCLE_M);
    map.getSource("inside").setData(placesGeoJSON(((s) => (p) => s.has(p))(new Set(inside))));

    const counts = state.kinds.map((_, k) => inside.filter((p) => p[2] === k).length);
    const missing = state.kinds.filter((_, k) => counts[k] === 0).map((k) => k.label.toLowerCase());
    const have = counts.filter((c) => c > 0).length;

    // Walk to the nearest hospital or clinic.
    const near = nearestOfKind(lonlat, 0);
    let routeHtml = "";
    if (near) {
      const name = esc(near.place[3]);
      try {
        if (isoError) throw isoError;
        const r = await api.route(lonlat, [near.place[0], near.place[1]]);
        if (r.line.length) {
          map.getSource("route").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r.line } });
        }
        const mins = Math.round(r.duration / 60);
        routeHtml = `<div class="route">Nearest hospital or clinic: <b>${name}</b>, a <b>${mins}-minute walk</b> (${(r.distance / 1000).toFixed(1)} km by street).${mins > 15 ? ` That's <b>${mins - 15} minutes over</b> the line.` : ""}</div>`;
      } catch {
        const mins = Math.round(crowToMinutes(near.metres));
        routeHtml = `<div class="route">Nearest hospital or clinic: <b>${name}</b>, about <b>${mins} minute${mins === 1 ? "" : "s"}</b> on foot (straight-line estimate).</div>`;
      }
    }

    const area15 = multiArea(walk15);
    const areaCircle = Math.PI * CIRCLE_M * CIRCLE_M;
    const pct = Math.round((area15 / areaCircle) * 100);
    const circleNote = isoError
      ? `<p class="circle-note">${HAS_KEY ? "Couldn't reach Amazon Location Service just now" : "No Amazon Location API key is configured"}, so these rings are a straight-line estimate, not real streets.</p>`
      : `<p class="circle-note">The dashed circle is what "15 minutes" covers if you could walk in straight lines (1.2 km). Real streets reach <b>${pct}%</b> of that area here. The circle holds <b>${inCircle.length}</b> essential places; your feet reach <b>${inside.length}</b>.</p>`;

    const rows = state.kinds.map((k, i) => {
      const n = nearestOfKind(lonlat, i);
      const est = n ? `~${Math.round(crowToMinutes(n.metres))} min` : "–";
      return `<tr><th><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${KIND_COLOURS[i]};margin-right:6px"></i>${esc(k.label)}</th><td class="${counts[i] ? "" : "zero"}">${counts[i]}</td><td>${est}</td></tr>`;
    }).join("");

    box.classList.remove("loading");
    box.innerHTML = `
      <h3>Your 15-minute walk</h3>
      <p class="where">from near <b>${esc(area)}</b> · ${lonlat[1].toFixed(4)}, ${lonlat[0].toFixed(4)}</p>
      <div class="key-swatches"><span class="k-walk">${isoError ? "estimated" : "real"} walk: 5 / 10 / 15 min</span><span class="k-circle">1.2 km circle</span><span class="k-route">route</span></div>
      <p class="verdict"><b>${have} of 6</b> essentials within 15 minutes on foot.${missing.length ? ` Missing: <b>${esc(missing.join(", "))}</b>.` : " Everything's in reach."}</p>
      <table>
        <thead><tr><th>Essential</th><td>in walk</td><td>nearest</td></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${routeHtml}
      ${circleNote}
      <div class="actions"><button type="button" id="copy-link">Copy link to this walk</button><button type="button" id="clear">Clear</button></div>`;
    $("copy-link").onclick = async (ev) => {
      try { await navigator.clipboard.writeText(location.href); ev.target.textContent = "Link copied"; } catch { ev.target.textContent = location.href; }
    };
    $("clear").onclick = clearWalk;

    const mobile = window.matchMedia("(max-width: 820px)").matches;
    const pad = mobile ? 30 : 70;
    if (mobile) box.scrollIntoView({ behavior: "smooth", block: "start" });
    map.fitBounds([[Math.min(x0, lonlat[0] - 0.012), Math.min(y0, lonlat[1] - 0.012)], [Math.max(x1, lonlat[0] + 0.012), Math.max(y1, lonlat[1] + 0.012)]], { padding: pad, maxZoom: 15, duration: 900 });
    state.busy = false;
  }

  function clearWalk() {
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["iso", "circle", "route", "inside", "origin"]) map.getSource(id).setData(empty);
    $("result").hidden = true;
    map.setPaintProperty("hex-fill", "fill-opacity", HEX_OPACITY);
    history.replaceState(null, "", location.pathname);
  }

  // ---------- panel ----------

  function renderChips() {
    const chips = $("chips");
    const make = (mode, label, colour) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.mode = mode;
      b.setAttribute("role", "radio");
      b.innerHTML = (colour ? `<i style="background:${colour}"></i>` : "") + esc(label);
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
        <div class="labels"><span>0 of 6</span><span>essentials within ~15 min walk</span><span>6 of 6</span></div>`;
    } else {
      lg.innerHTML = `<div class="ramp">${MINUTE_COLOURS.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="labels"><span>5</span><span>10</span><span><b>15 min</b></span><span>20</span><span>30</span><span>30+</span></div>`;
    }
  }

  function renderFindings() {
    const s = state.summary;
    $("stat-no-hospital").textContent = fmt(Math.round(s.people_no_hospital / 1000) * 1000);
    $("bars").innerHTML = state.kinds.map((k) => {
      const v = s.share_within_reach[k.key];
      return `<div class="bar"><span>${esc(k.label)}</span><span class="track"><span class="fill" style="width:${(v * 100).toFixed(1)}%;display:block"></span></span><span class="pct">${Math.round(v * 100)}%</span></div>`;
    }).join("");
    $("all-six").innerHTML = `Share of ${fmt(s.population)} people with each essential within ~15 minutes on foot. Only <b>${Math.round(s.share_all_six * 100)}%</b> have all six.`;
    $("worst").innerHTML = s.worst_areas_for_hospital.map((w, i) =>
      `<li><button type="button" data-i="${i}"><span>${esc(w.name)}</span><span class="n">${fmt(w.people_beyond)}</span></button></li>`).join("");
    for (const b of $("worst").querySelectorAll("button")) {
      b.onclick = () => {
        const w = s.worst_areas_for_hospital[Number(b.dataset.i)];
        analyse([w.lon, w.lat], w.name);
      };
    }
  }

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
    try { results = await api.geocode(q.match(/chennai/i) ? q : `${q}, Chennai`); } catch (err) { console.warn(err); }
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
    $("show-places").onchange = (e) => map.setLayoutProperty("places", "visibility", e.target.checked ? "visible" : "none");
    for (const id of ["hex-fill", "places"]) {
      map.on("mousemove", id, onHover);
      map.on("mouseleave", id, () => popup.remove());
    }
    map.on("mouseenter", "hex-fill", () => { map.getCanvas().style.cursor = "crosshair"; });
    map.on("click", (e) => analyse([e.lngLat.lng, e.lngLat.lat]));
    const m = location.hash.match(/^#@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) analyse([Number(m[2]), Number(m[1])]);
    window.__reachReady = true;
  });
  dataReady.catch((err) => {
    $("panel").insertAdjacentHTML("afterbegin", `<p class="small" style="color:#c2410c">Couldn't load the map data (${esc(err.message)}). Try reloading.</p>`);
  });
})();
