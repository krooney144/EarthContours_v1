# EarthContours v1

**Terrain visualization web app** — explore US elevation data through AR, 3D orbit, and topographic map views.

![Version](https://img.shields.io/badge/version-2.2-blue) ![Status](https://img.shields.io/badge/status-active-green)

---

## What It Does

EarthContours renders geographic elevation data across the United States in three interactive modes:

| Screen | Description |
|--------|-------------|
| **SCAN** | AR first-person panorama — 6-band depth-layered ridgeline renderer (ultra-near/near/mid-near/mid/mid-far/far), single `project()` camera function, AGL re-projection without worker round-trip, 400 km range, progressive contour intervals (50ft→2000ft), ocean-depth palette |
| **EXPLORE** | 3D terrain explorer — free-roam pan/zoom/orbit, real peak label projection, location pin from MAP |
| **MAP** | Dark topographic map — Carto Dark Matter tiles on Canvas, with peak/river overlays |
| **SETTINGS** | User preferences — units, labels, performance, data resolution |

Elevation data comes from **AWS Terrarium RGB-encoded DEM tiles** (public dataset, no API key). Procedural terrain (Gaussian + sine waves) is kept as a Tier 5 offline fallback. Real Colorado/Alaska/Cascades peak coordinates are included, with live OSM Overpass peak loading for any worldwide viewpoint.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | React 18.3.1 + TypeScript 5.4.2 |
| Build | Vite 5.2.0 |
| State | Zustand 4.5.2 (with localStorage persistence) |
| 3D (future) | Three.js 0.160.1 (scaffolded, not active in MVP) |
| Rendering | Canvas 2D API (terrain), SVG (contour overlays) |
| Styling | CSS Modules + CSS Custom Properties |
| Fonts | Josefin Sans (display) + Jost (body) via Google Fonts |

---

## Getting Started

```bash
npm install          # Install dependencies
npm run dev          # Dev server → http://localhost:5173
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run build        # Production build → /dist
npm run preview      # Preview production build
```

**Requirements:** Node.js 18+ (ES2020 support)

---

## Project Structure

```
EarthContours_v1/
├── src/
│   ├── App.tsx                    # Root component, routing, splash, error boundaries
│   ├── main.tsx                   # React root init
│   ├── screens/
│   │   ├── ScanScreen/            # AR first-person panorama — Phase 2 full implementation
│   │   ├── ExploreScreen/         # 3D orbit + contour lines
│   │   ├── MapScreen/             # Topographic tile map
│   │   └── SettingsScreen/        # User preferences
│   ├── components/
│   │   ├── Nav/                   # Bottom navigation bar (4 tabs)
│   │   ├── SplashScreen/          # 2.4s animated intro
│   │   ├── PreviewLayout/         # Desktop multi-screen command center
│   │   ├── LoadingScreen/         # Terrain load progress indicator
│   │   └── ErrorBoundary/         # Per-screen error isolation
│   ├── store/
│   │   ├── uiStore.ts             # Screen routing & transition animations
│   │   ├── settingsStore.ts       # Persisted user preferences
│   │   ├── cameraStore.ts         # AR + orbit camera state (fov, setFov, applyFovScale)
│   │   ├── locationStore.ts       # GPS & explore location
│   │   └── terrainStore.ts        # Elevation mesh, peaks, rivers
│   ├── core/
│   │   ├── types.ts               # TypeScript interfaces (incl. SkylineData, SkylineRequest)
│   │   ├── utils.ts               # Pure utility functions
│   │   ├── constants.ts           # Timings, defaults, breakpoints
│   │   ├── logger.ts              # Namespace-scoped color logger
│   │   └── errors.ts              # Custom error classes (recoverable vs fatal)
│   ├── data/
│   │   ├── regions.ts             # Region metadata (Colorado, Alaska, Cascades)
│   │   ├── simulatedData.ts       # Real Colorado/Alaska/Cascades peak coords
│   │   ├── simulatedTerrain.ts    # Procedural terrain generator (Tier 5 fallback)
│   │   ├── elevationLoader.ts     # 4-tier elevation fallback loader
│   │   ├── ScanTileCache.ts       # Multi-zoom tile cache (z8–z15) for SCAN 400km range
│   │   └── peakLoader.ts          # OSM Overpass peak fetcher with 24h IndexedDB cache
│   ├── workers/
│   │   └── skylineWorker.ts       # Web Worker — 360° skyline precomputation (720 azimuths)
│   ├── renderer/
│   │   └── TerrainRenderer.ts     # Three.js scaffold (future WebGL)
│   └── styles/
│       ├── global.css             # CSS reset + app-wide styles
│       └── palette.css            # Ocean-depth CSS variable palette
├── CLAUDE/
│   └── phase-2-scan-overhaul.md   # Phase 2 engineering plan + implementation notes
├── public/
│   └── Favicon3.svg
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Key Architecture Decisions

**State-based routing** — Zustand `uiStore` manages active screen instead of URL paths. Enables custom zoom transition animations and native app feel (no URL changes).

**Elevation data fallback chain** (4-tier):
1. **Tier 1 — Memory cache** — in-process, instant, survives only the current page load
2. **Tier 2 — IndexedDB** — persisted browser cache; tiles from Tier 4 are stored here after first fetch
3. **Tier 3 — Local `/tiles/elevation/` bundle** — pre-downloaded PNG tiles for true offline use; empty by default
4. **Tier 4 — AWS Terrarium** (live) — `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` — public dataset, no API key required; Terrarium RGB encoding: `elevation_m = R×256 + G + B/256 − 32768`
5. **Tier 5 — Procedural fallback** — Gaussian peaks + sine waves; always works, used only if all network tiers fail

**Active data source (as of Session 2):** AWS Terrarium tiles (Tier 4). Mount Elbert test region (39.1°N, 106.4°W) should show max elevation ~4400m (14,440 ft). Open the browser console and filter for `ELEVATION LOAD` or `TERRAIN SOURCE` to see which tier is active at runtime.

**Rendering approaches per screen:**
- SCAN (v2.2): **6-band depth-layered architecture** — Single `project()` camera function for all coordinate conversions. Worker produces depth-banded skyline (ultra-near 0–4.5km, near 4–10.5km, mid-near 10–31km, mid 30–81km, mid-far 80–152km, far 150–400km) with raw elevation+distance per azimuth. Progressive contour intervals (50ft→2000ft). z15/z14 tile zoom for ultra-near, hybrid ray march (360-az 20–200m + 2880-az 200m–31km). `renderTerrain()` draws bands in painter's order (far→near) with depth cues: line weight 1→5px, opacity 0.15→0.9, progressive fill darkness. `reprojectBands()` re-derives angles when AGL changes — no worker round-trip. Debug panel shows camera state, re-projection validation, per-band health + contour intervals, peak funnel. Stale-while-revalidate; skip recompute < 1.5km. Peak labels max 8, ridgeline snap via `project()`. Pinch-zoom FOV 15°–100°. OSM Overpass worldwide peaks with 24h cache.
- EXPLORE: Marching squares (extracts contour line segments at elevation thresholds). Free-roam navigation: left-drag/1-finger = pan, right-drag = rotate+tilt, scroll/pinch = zoom, double-click = fly-to. Peak labels use real `project3D()` projection from actual lat/lng. Pulsing gold location pin appears when MAP sets an explore point.
- MAP: Canvas tile fetching with overlay graphics. Tap anywhere to set the explore location (synced to EXPLORE and SCAN via `locationStore`).

**Layout:**
- Mobile: Single screen + bottom nav
- Desktop (>900px): Multi-screen "preview mode" showing all views side-by-side

---

## Roadmap

| Session | Focus |
|---------|-------|
| **1 (done)** | MVP — procedural terrain, Canvas/SVG rendering, mock data |
| **2 (done)** | Real AWS Terrarium DEM tiles, fixed elevation loader, real Colorado terrain |
| **2.5 (done)** | EXPLORE fixes: correct vertical exaggeration, real peak label coordinates, free-roam navigation (pan/zoom/tilt/fly-to), MAP→EXPLORE location sync with pulsing pin |
| **v1.1 (done)** | ENU metre-space coordinate system; `orbitRadius` in metres; 3 named regions (Colorado, Alaska, Cascades) |
| **v1.2 (done)** | SCAN Phase 1: bilinear sampling, logarithmic rays (476 steps), Earth curvature + refraction, hill shading, 120km range |
| **v1.3 (done)** | SCAN Phase 2: `ScanTileCache` (z8–z13 multi-zoom), `skylineWorker` (720-azimuth precomputation), OSM Overpass peaks (worldwide, 24h cache), pinch-zoom FOV (15°–100°), pitch indicator, 250km range, O(1) mobile shading |
| **v1.4 (done)** | SCAN performance overhaul: worker-only rendering (removed main-thread ray march + double tile fetch), canvas RAF gating + ResizeObserver-only resize, ridgeline peak visibility filter (max 15), peak dot snap to ridgeline Y, natural drag direction |
| **v1.4.1 (done)** | SCAN bugfixes: DPR coordinate mismatch, stale-while-revalidate skyline, skip recompute < 1.5 km, peak label dedup |
| **v2.0 (done)** | SCAN architectural overhaul: single `project()` camera, depth-banded skyline (near/mid/far), AGL re-projection, layered renderer with depth cues, comprehensive debug panel |
| **v2.2 (done)** | Near-field enhancement: 6-band system (ultra-near/near/mid-near/mid/mid-far/far), progressive contour intervals (50ft→2000ft), z15/z14 tile zoom, hybrid ray march, scaled overlaps |
| **v2.3** | Interior contour fragments (slope-driven linework, Phase 5) |
| **3** | Real GPS, DeviceOrientation/magnetometer for true AR, Three.js WebGL renderer |
| **Future** | Museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Settings Persisted to localStorage

- **Units**: Imperial / Metric
- **Labels**: Toggle peaks, rivers, water, towns
- **Visual**: Theme, label size, vertical exaggeration
- **Performance**: FPS target, battery saver mode
- **Data**: Tile resolution, WiFi-only downloads
