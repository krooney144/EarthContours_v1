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
  - `elevScale = verticalExaggeration` (no hidden 0.25× compression; 1× = uncompressed)
  - Peak labels use real `project3D()` with lat/lng from `simulatedData.ts` (not fake trig)
  - Pulsing gold dot renders at MAP-selected location using `locationStore.mode === 'exploring'`
  - `cameraStore.orbitPanX/orbitPanZ` control terrain pan offset; `orbitRadius` controls zoom scale
- **MAP**: Carto Dark Matter tile fetching on Canvas with overlay graphics (peaks, rivers). Tap to `setExploreLocation(lat, lng)` — syncs EXPLORE and SCAN.

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
| 3 | GPS + DeviceOrientation for true AR, Three.js WebGL renderer |
| Future | Museum exhibit mode (7680×1080 triple ultra-wide) |

---

## Coding Conventions

- Strict TypeScript — no implicit any, strict null checks
- Logger everywhere: `const log = createLogger('ComponentName')` then `log.info(...)`, `log.warn(...)`, `log.error(...)`
- Sections separated with `// ─── Section Name ───` comments
- Path alias `@/` maps to `src/` (configured in tsconfig.json)
- Stores exported as hooks: `useUIStore`, `useLocationStore`, etc.
