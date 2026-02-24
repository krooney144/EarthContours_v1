# EarthContours v1 — Claude Context Document

Quick reference for any Claude Code session in this repo.

---

## What This Project Is

A **terrain visualization web app** (React + TypeScript + Vite) for exploring US elevation data.
- **v1.3** — SCAN Phase 2 complete: 250km skyline worker, multi-zoom tile cache, OSM peaks, pinch zoom, pitch indicator.
- Mobile-first, state-based routing (no URL changes), native app feel.
- 4 screens: SCAN (AR first-person panorama), EXPLORE (3D orbit), MAP (topo tiles), SETTINGS.

---

## Branch

Active development branch: `claude/update-scan-feature-W1uNa`

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
| `terrainStore` | Elevation mesh, peaks, rivers, loading state |

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
| `src/core/types.ts` | All TypeScript interfaces (incl. `SkylineData`, `SkylineRequest`) |
| `src/core/constants.ts` | Magic numbers (timings, breakpoints, defaults) |
| `src/core/logger.ts` | `createLogger(namespace)` — colored, timestamped logs |
| `src/core/errors.ts` | Custom error classes (recoverable vs fatal) |
| `src/data/elevationLoader.ts` | 4-tier elevation fallback (IndexedDB → local → AWS → procedural) |
| `src/data/ScanTileCache.ts` | Multi-zoom tile cache (z8–z13) for SCAN 250km range |
| `src/data/peakLoader.ts` | OSM Overpass peak loader with 24h IndexedDB cache |
| `src/data/simulatedTerrain.ts` | Procedural terrain (Gaussian peaks + sine waves) |
| `src/data/simulatedData.ts` | Real Colorado/Alaska/Cascades peak coords |
| `src/workers/skylineWorker.ts` | Web Worker — 360° skyline precomputation (720 azimuths) |
| `src/renderer/TerrainRenderer.ts` | Three.js scaffold (future WebGL) |

---

## Rendering Per Screen

- **SCAN** (v1.3 — Phase 2 complete): Two-path renderer.
  - **QUICK path** (O(W)/frame): reads pre-computed `SkylineData` from `skylineWorker.ts` — instant silhouette from 720-azimuth precomputed skyline with per-azimuth hill shade
  - **FULL path**: logarithmic ray march (1.5% growth, 100m→250km, ~595 steps) using `ScanTileCache` (z8–z13 multi-zoom AWS Terrarium tiles); `sampleBestAvailable()` picks zoom from distance
  - `cheapDirectionalShade(bearingDeg)` = O(1) cosine per column (no live finite-difference normals — mobile perf)
  - `fetchPeaksNear(lat, lng, 130)` fetches worldwide OSM peaks on location change; falls back to hardcoded peaks
  - `applyFovScale(scale)` changes FOV via pinch gesture (15°–100°)
  - `PitchIndicator` component on left edge; loading progress bar; FOV badge
  - Subscribes to `locationStore.activeLat/activeLng` — re-centers when MAP sets explore location
  - See `CLAUDE/phase-2-scan-overhaul.md` for full implementation notes
- **EXPLORE**: Marching squares — contour lines at elevation thresholds, projected via free-roam orbit camera.
  - Navigation: left-drag/1-finger = pan, right-drag = rotate+tilt, scroll/pinch = zoom, double-click = fly-to
  - **ENU metre-space** (v1.1): all world coords in metres; `verticalExaggeration` is the ONLY modifier of Y
  - Peak labels and contour lines share `computeENULayout()` so they always match
  - Teal dot renders at MAP-selected location using `locationStore.mode === 'exploring'`
  - `cameraStore.orbitPanX/orbitPanZ` = pan as fraction of terrain width/depth [-0.5, 0.5]
  - `cameraStore.orbitRadius` = camera distance from pivot in **metres**; auto-set by `initOrbitCamera(terrainWidth_m)`
- **MAP**: Carto Dark Matter tile fetching on Canvas with overlay graphics (peaks, rivers). Tap to `setExploreLocation(lat, lng)` — syncs EXPLORE and SCAN.

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
| 3 | Real GPS (`navigator.geolocation`), `DeviceOrientationEvent` heading for true AR, peak ridgeline visibility (P2.3), worldwide viewpoint selection (P2.5), HTTPS deployment for camera overlay |
| Future | Three.js WebGL renderer; museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Coding Conventions

- Strict TypeScript — no implicit any, strict null checks
- Logger everywhere: `const log = createLogger('ComponentName')` then `log.info(...)`, `log.warn(...)`, `log.error(...)`
- Sections separated with `// ─── Section Name ───` comments
- Path alias `@/` maps to `src/` (configured in tsconfig.json)
- Stores exported as hooks: `useUIStore`, `useLocationStore`, etc.
