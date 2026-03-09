# EarthContours v1 — Claude Context Document

Quick reference for any Claude Code session in this repo.

---

## What This Project Is

A **terrain visualization web app** (React + TypeScript + Vite) for exploring US elevation data.
- **v2.3-globe** — Globe mode for MAP screen: Three.js Earth sphere at zoom 1–5 with smooth crossfade to flat DEM map at zoom 7+. Mercator-corrected UV mapping on SphereGeometry(1, 96, 96). MeshBasicMaterial (unlit) to avoid Lambert darkening of already-dark DEM colors. Brightness-lifted globe texture (1.5×R + 1.4×G + 1.3×B + floor). Two-phase texture loading: z2 (16 tiles) instant, z3 (64 tiles) background upgrade. Atmosphere Fresnel shader on BackSide r=1.04 sphere with ec-mid/ec-glow palette colors. 300-point star field. Single source of truth: centerLat/centerLng drives both globe rotation and flat map position. Smooth zoom slider (range input, step 0.1) replaces integer +/- buttons. Flat map drawMap() skipped entirely when globe opacity = 1 (performance). Debug panel shows UV mode, material type, atmos params, flat-map-skip status.
- **v2.2.2** — Two-pass peak refinement: replaced auto-detect Phase 6 with peak-driven refinement. Main thread identifies visible peaks and sends `'refine-peaks'` to worker. Worker fetches HIGHER-ZOOM tiles (`distToRefinedZoom()`: +1–2 zoom levels above standard) around each peak, does dense 0.05° ray-march with 1.005× distance steps. Genuinely more terrain data, not resampled. Stale-while-revalidate: old arcs persist until new ones arrive. `PeakRefineItem` type for request protocol. Debug panel shows "REFINED ARCS (2nd pass)" with per-peak stats.
- **v2.2.1** — Refined arc system (superseded by v2.2.2): worker Phase 6 auto-detected ridgeline features — failed because near-field angular prominence dominated, visible far peaks got zero arcs.
- **v2.2** — Near-field enhancement: 6-band depth system (ultra-near/near/mid-near/mid/mid-far/far) with progressive contour intervals (50ft→2000ft), z15/z14 tile zoom for ultra-near detail, hybrid ray march (360-az 20–200m @ 1.005× + 2880-az 200m–31km @ 1.01×), scaled overlaps (0.5–2 km). Ultra-near band enables valley views and cliff-face rendering within 4.5 km.
- **v2.0.1** — GPS-coordinate ridge attachment: `SkylineBand` now stores `ridgeLats`/`ridgeLngs` per azimuth so every ridge point has a real-world GPS position. Peak dot snapping rewritten to use per-band angles (matching exactly what's drawn) instead of the coarser 720-azimuth overall array; snap is upward-only so peaks above all bands keep their true position.
- **v2.0** — SCAN architectural overhaul: single `project()` camera function (all bearing/angle→screen conversions go through one function — alignment bugs structurally impossible), depth-banded skyline (near/mid/far bands with raw elevation+distance per azimuth), main-thread AGL re-projection (no worker round-trip for height changes), layered renderer (painter's order far→near with depth cues: line weight 0.5→3px, opacity 0.15→0.8, progressive fill darkness), comprehensive debug diagnostics panel.
- **v1.4.1** — SCAN bugfixes: DPR coordinate mismatch, stale-while-revalidate skyline, skip recompute for moves < 1.5 km, peak label improvements.
- **v1.4** — SCAN performance overhaul: worker-only rendering, canvas RAF gating, ridgeline peak filtering, peak dot snap to ridgeline, natural drag direction.
- Mobile-first, state-based routing (no URL changes), native app feel.
- 4 screens: SCAN (AR first-person panorama), EXPLORE (3D orbit), MAP (topo tiles), SETTINGS.

---

## Branch

Active development branch: `claude/enhance-scan-near-field-e4qkR`

---

## Commands

```bash
npm run dev          # Dev server → http://localhost:5173
npm run build        # Production build → /dist
npm run type-check   # tsc type checking (noEmit)
npm run lint         # ESLint
npm run preview      # Preview production build
```

---

## Stack

- **React 18.3.1** + **TypeScript 5.4.2** (strict mode)
- **Vite 5.2.0** (ES2020, source maps on)
- **Zustand 4.5.2** (state management + localStorage persistence)
- **Three.js 0.160.1** (scaffolded, not yet active)
- **Canvas 2D** for terrain rendering, **SVG** for contour overlays
- **CSS Modules** + CSS Custom Properties (ocean-depth palette)

---

## State Management

Five Zustand stores in `src/store/`:

| Store | Role |
|-------|------|
| `uiStore` | Active screen, transitions, splash, preview mode |
| `settingsStore` | User prefs — persisted to localStorage |
| `cameraStore` | AR camera (heading/pitch/height) + orbit camera (theta/phi/radius/panX/panZ) |
| `locationStore` | GPS position, explore location, sensor data |
| `terrainStore` | Elevation mesh, peaks, rivers, water bodies, loading state |

---

## Routing

Screen IDs (`ScreenId` type): `'scan' | 'explore' | 'map' | 'settings'`

Routing is **state-based** via `uiStore.activeScreen` — no React Router, no URL changes.
Transitions use zoom animation stored in `uiStore`.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component — splash, routing, layouts, error boundaries |
| `src/core/types.ts` | All TypeScript interfaces (incl. `SkylineData`, `SkylineRequest`, `RefinedArc`) |
| `src/core/constants.ts` | Magic numbers (timings, breakpoints, defaults) |
| `src/core/logger.ts` | `createLogger(namespace)` — colored, timestamped logs |
| `src/core/errors.ts` | Custom error classes (recoverable vs fatal) |
| `src/data/elevationLoader.ts` | 4-tier elevation fallback (IndexedDB → local → AWS → procedural) |
| `src/data/ScanTileCache.ts` | Multi-zoom tile cache (z8–z13) for SCAN 250km range |
| `src/data/peakLoader.ts` | OSM Overpass peak loader with 24h IndexedDB cache |
| `src/data/waterLoader.ts` | OSM Overpass lake/reservoir polygon loader with 24h IndexedDB cache |
| `src/data/simulatedTerrain.ts` | Procedural terrain (Gaussian peaks + sine waves) |
| `src/data/simulatedData.ts` | Real Colorado/Alaska/Cascades peak coords |
| `src/workers/skylineWorker.ts` | Web Worker — 360° skyline precomputation (720 az) + Phase 6 refined arcs |
| `src/renderer/TerrainRenderer.ts` | Three.js scaffold (future WebGL) |

---

## Rendering Per Screen

- **SCAN** (v2.2.1 — refined arcs + 6-band near-field):
  - **Single camera function** — `project(bearingDeg, elevAngleRad, cam) → {x, y}` is the ONE source of truth for all bearing/angle→screen conversions. Ridgeline renderer, peak dots, peak labels all call it. Alignment bugs structurally impossible.
  - **6-band depth-banded skyline** — Worker produces `SkylineData` with 6 depth bands (ultra-near/near/mid-near/mid/mid-far/far). Each band stores per-azimuth raw elevation + distance + **GPS lat/lng of each ridge point**. Scaled overlaps at boundaries (0.5 km close, 1 km mid, 2 km far) prevent seams. Array-driven — adding bands = pushing to `DEPTH_BANDS`.
  - **Ultra-near band (0–4.5 km)** — Dedicated band for close terrain with 50ft contour intervals, z15/z14 tile resolution, and hybrid ray march (360 azimuths 20–200m @ 1.005× step, 2880 azimuths 200m–4.5km @ 1.01× step). Enables valley views and cliff-face rendering.
  - **Progressive contour intervals** — 50ft (ultra-near) → 100ft (near) → 200ft (mid-near) → 500ft (mid) → 1000ft (mid-far) → 2000ft (far).
  - **Tile zoom levels** — z15 (0–1km), z14 (1–4.5km), z13 (4.5–10.5km), z11 (10.5–31km), z10 (31–81km), z9 (81–152km), z8 (152–400km).
  - **AGL re-projection** — `reprojectBands()` re-derives elevation angles from raw band data when viewer height changes. ~15,840 atan2 calls, sub-millisecond. No worker round-trip for AGL slider changes.
  - **Layered renderer** — `renderTerrain()` draws bands in painter's order (far→near) with depth cues: line weight (1→5px), opacity (0.15→0.9), fill darkness. Band count is array-driven — visual parameters auto-interpolate.
  - **Canvas RAF gating** — `resizeCanvas()` only runs on ResizeObserver; `redrawCanvas()` is gated through `requestAnimationFrame`.
  - **Physical-pixel coordinate system** — `ctx.setTransform(1,0,0,1,0,0)` (identity); all drawing in physical pixels. Peak positions divided by `dpr` only for HTML overlay CSS coords.
  - **Stale-while-revalidate** — old skyline stays visible while worker recomputes; skip recompute for moves < 1.5 km.
  - **Peak visibility + snap** — `isPeakVisible()` checks peak angle vs ridgeline. Dots snap to max per-band ridgeline angle at the peak's bearing (matches exactly what's drawn); snap is upward-only so peaks above all bands keep their true position. Max 8, horizontal dedup at 10% canvas width.
  - **Two-pass peak refinement (v2.2.2)** — After skyline completes, main thread identifies visible peaks and sends `{ type: 'refine-peaks', peaks: PeakRefineItem[] }` to worker. Worker fetches HIGHER-ZOOM tiles (`distToRefinedZoom()`: z15/z14/z13/z11/z10/z9 — 1–2 levels above standard) around each peak's GPS position. Dense ray-march at 0.05° steps (5× finer than hi-res 0.125°) with 1.005× distance steps through the peak's band range. Worker responds with `{ type: 'refined-arcs', refinedArcs }`. `renderPeakRidgelines()` matches peaks to arcs by bearing+band; falls back to band data for unmatched peaks. `RefinedArc` + `PeakRefineItem` types in `types.ts`.
  - **Debug diagnostics** — Comprehensive debug panel: camera state, re-projection validation (max angle diff), per-band health (active azimuths, elevation/distance ranges, contour interval), refined arc stats (feature count, samples, per-arc details), peak funnel.
  - `fetchPeaksNear(lat, lng, 130)` fetches worldwide OSM peaks on location change; falls back to hardcoded peaks
  - `applyFovScale(scale)` changes FOV via pinch gesture (15°–100°)
  - `PitchIndicator` component on left edge; loading progress bar; FOV badge
  - Subscribes to `locationStore.activeLat/activeLng` — re-centers when MAP sets explore location
- **EXPLORE**: Marching squares — contour lines at elevation thresholds, projected via free-roam orbit camera.
  - Navigation: left-drag/1-finger = pan, right-drag = rotate+tilt, scroll/pinch = zoom, double-click = fly-to
  - **ENU metre-space** (v1.1): all world coords in metres; `verticalExaggeration` is the ONLY modifier of Y
  - Peak labels and contour lines share `computeENULayout()` so they always match
  - Teal dot renders at MAP-selected location using `locationStore.mode === 'exploring'`
  - `cameraStore.orbitPanX/orbitPanZ` = pan as fraction of terrain width/depth [-0.5, 0.5]
  - `cameraStore.orbitRadius` = camera distance from pivot in **metres**; auto-set by `initOrbitCamera(terrainWidth_m)`
- **MAP**: Dual-canvas map with Three.js globe (zoom 1–6) and Canvas 2D flat DEM (zoom 7–16). Globe uses Mercator-corrected sphere with brightness-lifted DEM texture. Smooth CSS opacity crossfade at zoom 5–7. Carto dark_only_labels overlay at flat zoom. All overlays (GPS dot, explore marker, peaks, lakes, area selection) on flat map. Tap to `setExploreLocation(lat, lng)` — syncs EXPLORE and SCAN. Smooth zoom slider with 0.1 step granularity. **Lake polygons**: `waterLoader.ts` fetches lake/reservoir polygons from OSM Overpass API (`natural=water` ways+relations with `name` tag, `out geom`). IndexedDB-cached 24h. Rendered as semi-transparent blue polygons on flat map at zoom 7+, labels at zoom 9+. Controlled by `showWaterLabels` toggle in Settings. Lake stats visible in Globe Debug panel.

---

## EXPLORE Coordinate System (ENU — v1.1)

All world coordinates in EXPLORE are in a local **ENU (East-North-Up)** frame centred on the loaded region's geographic centre (`lat0, lon0`):

```
lat0 = (bounds.north + bounds.south) / 2
lon0 = (bounds.east  + bounds.west ) / 2

MPD_LAT = 111 132 m/°            (nearly constant)
MPD_LON = 111 320 × cos(lat0°)   (shrinks toward poles)

x_m = (col/(w-1) − 0.5) × terrainWidth_m  − pivotX_m   ← east/west
z_m = (row/(h-1) − 0.5) × terrainDepth_m  − pivotZ_m   ← south (z+ = south in grid)
y_m = (elevation_m − minElevation_m) × verticalExaggeration  ← up

scale  = pixels/metre = min(W,H) × 0.62 / orbitRadius
pivot  = (panX × terrainWidth_m,  panZ × terrainDepth_m)   in metres
```

**Rule:** nothing else ever multiplies or divides elevation. At 1×, 1 m of terrain = 1 m of world Y.

---

## Predefined Terrain Regions (`src/data/regions.ts`)

Regions are hand-tuned geographic chunks sized for visual quality, **not political borders**.

| Region | ID | Approx size | Notes |
|--------|----|-------------|-------|
| Colorado Rockies | `colorado-rockies` | ~220×250 km | 53 14ers; default region |
| Alaska Range | `alaska-range` | ~255×220 km | Denali 6190 m |
| Washington Cascades | `wa-cascades` | ~230×220 km | Rainier 4392 m |

**Adding regions:** Add an entry in `src/data/regions.ts`. Target ≤300 km/side (flat-earth error < 0.2%). Regions may overlap — tiles are cached by z/x/y so shared tiles auto-reuse. Update `DEFAULT_REGION_ID` in `constants.ts` if needed.

**Flat-earth accuracy:** 50 km → <1 m error; 150 km → <10 m; 300 km → <50 m. Fine for all current regions.

---

## Camera System (orbit around pivot)

`cameraStore` orbit camera fields:

| Field | Type | Meaning |
|-------|------|---------|
| `orbitRadius` | metres | Camera distance from pivot — zoom = change this |
| `orbitDefaultRadius` | metres | Set by `initOrbitCamera(terrainWidth_m)` — reference for pan sensitivity |
| `orbitPanX/Z` | fraction [-0.5, 0.5] | Pivot offset as fraction of terrain width/depth |
| `orbitTheta` | radians | Horizontal orbit angle |
| `orbitPhi` | radians | Vertical tilt (0.1 = top-down, 1.45 = side-on) |

`initOrbitCamera(terrainWidth_m)` is called from `ExploreScreen` whenever `meshData` changes. It sets `orbitRadius = terrainWidth_m × 0.8` so the full terrain is visible at load. No auto-rotation.

---

## Elevation Data — Fallback Chain

**Active source:** AWS Terrarium tiles (Tier 4 below). After first fetch, tiles are cached to IndexedDB (Tier 2).

| Tier | Source | Notes |
|------|--------|-------|
| 1 | In-memory cache | Fastest; current page load only |
| 2 | IndexedDB | Persistent browser cache; auto-populated from Tier 4 |
| 3 | `/tiles/elevation/{z}/{x}/{y}.png` | Pre-bundled offline tiles; empty by default |
| 4 | AWS Terrarium (live) | `s3.amazonaws.com/elevation-tiles-prod/terrarium/` — no API key |
| 5 | Procedural fallback | Gaussian peaks + sine waves; only when all network tiers fail |

**Tile format:** Terrarium RGB-encoded PNG — `elevation_m = R×256 + G + B/256 − 32768`

**Colorado test point:** Mount Elbert at ~39.1°N, 106.4°W → expected ~4400m (14,440ft).

**Console debugging:** filter for `ELEVATION LOAD` or `TERRAIN SOURCE` to see the active tier.

---

## Layout

- **Mobile**: Single screen + bottom nav bar
- **Desktop (>900px)**: "Preview mode" — all 3 terrain screens side-by-side command center
  - Preview locks off once user clicks into a screen

---

## Error Handling

- Per-screen `ErrorBoundary` components — crashes isolated to single screen
- Custom error classes in `src/core/errors.ts`:
  - GPS failure → non-fatal (falls back to simulated position)
  - Terrain load failure → recoverable (shows retry button)
  - Tile fetch failure → falls back to next tier in elevation chain

---

## CSS System

- `src/styles/palette.css` — CSS custom properties: ocean-depth color palette, spacing scale, z-index layers, shadows
- `src/styles/global.css` — CSS reset, root element, typography defaults
- Each component has its own `.module.css` file (CSS Modules)
- Fluid typography with `clamp()` for responsive scaling

---

## Roadmap

| Session | Goal |
|---------|------|
| 1 (done) | MVP — procedural terrain, Canvas/SVG rendering |
| 2 (done) | Real AWS Terrarium DEM tiles; fixed elevation loader stack-overflow bug |
| 2.5 (done) | EXPLORE fixes: correct vertical exaggeration (removed hidden 0.25×), real peak label coordinates via project3D(), free-roam pan/zoom/tilt/fly-to navigation, MAP→EXPLORE location sync with pulsing pin |
| v1.1 (done) | ENU metre-space coordinate system: 1 m X = 1 m Z = 1 m Y; real physical terrain proportions; `orbitRadius` in metres; `initOrbitCamera` auto-computes from terrain bounds; 3 named regions in `regions.ts`; exaggeration options 1/2/4/10/20× |
| v1.2 (done) | SCAN Phase 1: bilinear sampling, logarithmic ray steps (476 steps 100m→120km), Earth curvature + refraction, NW-45° hill shading; expanded peak data (Colorado +6, Alaska +5, Cascades 11) |
| v1.3 (done) | SCAN Phase 2: `ScanTileCache` (z8–z13 multi-zoom), `skylineWorker` (720-azimuth precomputation), OSM Overpass peaks (worldwide, 24h cache), pinch-zoom FOV (15°–100°), pitch indicator, 250km range, O(1) mobile shading |
| v1.4 (done) | SCAN performance overhaul: worker-only rendering (removed main-thread ray march + double tile fetch), canvas RAF gating + ResizeObserver-only resize, ridgeline peak visibility filter (max 15), peak dot snap to ridgeline Y, natural drag direction (negated deltaX) |
| v1.4.1 (done) | SCAN bugfixes: DPR coordinate mismatch fixed (horizon now correct at dpr>1), stale-while-revalidate skyline, skip recompute for moves < 1.5 km, peak labels max 8 + FOV-gated fallback + horizontal deduplication |
| v2.0 (done) | SCAN architectural overhaul: single `project()` camera function, depth-banded skyline (near/mid/far with raw elev+dist per azimuth), main-thread AGL re-projection (no worker round-trip), layered renderer (painter's order far→near with depth cues), comprehensive debug diagnostics |
| v2.0.1 (done) | GPS-coordinate ridge attachment: `SkylineBand.ridgeLats/ridgeLngs` per azimuth; peak dot snap rewritten to use per-band angles (matches drawn ridgeline exactly); upward-only snap preserves peaks above all bands |
| v2.1 | Phase 5: Interior contour fragments — slope-driven line fragments inside terrain bands, density decreasing with distance. Slope vectors already stored in `SkylineBand.slopeX/slopeZ`. |
| v2.2 (done) | Near-field enhancement: 6-band system (ultra-near/near/mid-near/mid/mid-far/far), progressive contour intervals (50ft→2000ft), z15/z14 tile zoom for ultra-near, hybrid ray march (360-az 20–200m + 2880-az 200m–31km), scaled overlaps (0.5–2 km) |
| v2.2.2 (done) | Two-pass peak refinement: replaced auto-detect with peak-driven `'refine-peaks'` protocol. Worker fetches higher-zoom tiles (`distToRefinedZoom()`, +1–2 levels) around each visible peak, dense 0.05° ray-march with 1.005× steps. Genuinely more terrain detail. Stale-while-revalidate arcs. `PeakRefineItem` type. |
| v2.2.1 | Refined arc auto-detect (superseded by v2.2.2 — near-field bias caused zero arcs at visible far peaks). |
| v2.3 | Near-band smoothing: address jumpy/steppy near+med-near ridgelines — either Gaussian smoothing or multi-point depth profiles per azimuth |
| v2.3-globe (done) | Globe mode for MAP: Three.js Earth sphere (zoom 1–6) with Mercator-corrected UVs, MeshBasicMaterial (unlit), brightness-lifted DEM texture, atmosphere Fresnel glow (BackSide r=1.04), 300 stars, smooth zoom slider, drawMap() skip at globe zoom, dual-canvas opacity crossfade |
| 3 | Real GPS (`navigator.geolocation`), `DeviceOrientationEvent` heading for true AR, worldwide viewpoint selection, HTTPS deployment for camera overlay |
| Future | Three.js WebGL renderer; museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Coding Conventions

- Strict TypeScript — no implicit any, strict null checks
- Logger everywhere: `const log = createLogger('ComponentName')` then `log.info(...)`, `log.warn(...)`, `log.error(...)`
- Sections separated with `// ─── Section Name ───` comments
- Path alias `@/` maps to `src/` (configured in tsconfig.json)
- Stores exported as hooks: `useUIStore`, `useLocationStore`, etc.
