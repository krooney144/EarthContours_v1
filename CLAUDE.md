# EarthContours v1 — Claude Context Document

Quick reference for any Claude Code session in this repo.

---

## What This Project Is

A **terrain visualization web app** (React + TypeScript + Vite) for exploring US elevation data.
- **Session 2** — real AWS Terrarium DEM tiles active; procedural terrain kept as Tier 5 fallback.
- Mobile-first, state-based routing (no URL changes), native app feel.
- 4 screens: SCAN (AR first-person), EXPLORE (3D orbit), MAP (topo tiles), SETTINGS.

---

## Branch

Active development branch: `claude/fix-explore-screen-issues-FYjik`

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
| `src/core/types.ts` | All TypeScript interfaces |
| `src/core/constants.ts` | Magic numbers (timings, breakpoints, defaults) |
| `src/core/logger.ts` | `createLogger(namespace)` — colored, timestamped logs |
| `src/core/errors.ts` | Custom error classes (recoverable vs fatal) |
| `src/data/elevationLoader.ts` | 4-tier elevation fallback (IndexedDB → local → AWS → procedural) |
| `src/data/simulatedTerrain.ts` | Procedural terrain (Gaussian peaks + sine waves) |
| `src/data/simulatedData.ts` | 53 real Colorado/Alaska peak coords |
| `src/renderer/TerrainRenderer.ts` | Three.js scaffold (Session 2 work) |

---

## Rendering Per Screen

- **SCAN**: Ray-height-field algorithm — casts rays per screen column, colors by elevation angle. Subscribes to `locationStore.activeLat/activeLng` — re-centers when MAP sets explore location.
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
| v1.1 (done) | ENU metre-space coordinate system: 1 m X = 1 m Z = 1 m Y; real physical terrain proportions; `orbitRadius` in metres; `initOrbitCamera` auto-computes from terrain bounds; `worldWidth_km` computed from actual bounds; 3 named regions in `regions.ts`; exaggeration options 1/2/4/10/20× |
| 3 | GPS + DeviceOrientation for true AR, Three.js WebGL renderer |
| Future | Museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Coding Conventions

- Strict TypeScript — no implicit any, strict null checks
- Logger everywhere: `const log = createLogger('ComponentName')` then `log.info(...)`, `log.warn(...)`, `log.error(...)`
- Sections separated with `// ─── Section Name ───` comments
- Path alias `@/` maps to `src/` (configured in tsconfig.json)
- Stores exported as hooks: `useUIStore`, `useLocationStore`, etc.
