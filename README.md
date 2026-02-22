# EarthContours v1

**Terrain visualization web app** — explore US elevation data through AR, 3D orbit, and topographic map views.

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Status](https://img.shields.io/badge/status-MVP-green)

---

## What It Does

EarthContours renders geographic elevation data across the United States in three interactive modes:

| Screen | Description |
|--------|-------------|
| **SCAN** | AR first-person view — Comanche-style ray-height-field renderer, shows peaks/rivers in your heading direction |
| **EXPLORE** | 3D terrain explorer — free-roam pan/zoom/orbit, real peak label projection, location pin from MAP |
| **MAP** | Dark topographic map — Carto Dark Matter tiles on Canvas, with peak/river overlays |
| **SETTINGS** | User preferences — units, labels, performance, data resolution |

Elevation data comes from **AWS Terrarium RGB-encoded DEM tiles** (public dataset, no API key). Procedural terrain (Gaussian + sine waves) is kept as a Tier 4 offline fallback. Real Colorado/Alaska peak coordinates are used for POI overlays.

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
│   │   ├── ScanScreen/            # AR first-person terrain view
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
│   │   ├── cameraStore.ts         # AR + orbit camera state
│   │   ├── locationStore.ts       # GPS & explore location
│   │   └── terrainStore.ts        # Elevation mesh, peaks, rivers
│   ├── core/
│   │   ├── types.ts               # TypeScript interfaces
│   │   ├── utils.ts               # Pure utility functions
│   │   ├── constants.ts           # Timings, defaults, breakpoints
│   │   ├── logger.ts              # Namespace-scoped color logger
│   │   └── errors.ts              # Custom error classes (recoverable vs fatal)
│   ├── data/
│   │   ├── regions.ts             # Region metadata (Colorado, Alaska)
│   │   ├── simulatedData.ts       # 53 real Colorado/Alaska peak coords
│   │   ├── simulatedTerrain.ts    # Procedural terrain generator
│   │   └── elevationLoader.ts     # 4-tier elevation fallback loader
│   ├── renderer/
│   │   └── TerrainRenderer.ts     # Three.js scaffold (Session 2)
│   └── styles/
│       ├── global.css             # CSS reset + app-wide styles
│       └── palette.css            # Ocean-depth CSS variable palette
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
- SCAN: Ray-height-field (casts rays per screen column, colors by elevation). Subscribes to `locationStore.activeLat/activeLng` — re-centers automatically when MAP sets explore location.
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
| **3** | Real GPS, DeviceOrientation/magnetometer for true AR, Three.js WebGL renderer |
| **Future** | Museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Settings Persisted to localStorage

- **Units**: Imperial / Metric
- **Labels**: Toggle peaks, rivers, water, towns
- **Visual**: Theme, label size, vertical exaggeration
- **Performance**: FPS target, battery saver mode
- **Data**: Tile resolution, WiFi-only downloads
