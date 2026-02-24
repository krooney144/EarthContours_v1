# Phase 2 — SCAN Screen Engineering Overhaul

> **Status: COMPLETE (v1.3)**
> P2.1 ScanTileCache, P2.2 SkylineWorker, and P2.4 OSM peaks are all implemented and live.
> See "Phase 2 Implementation Notes" section at the bottom for what was actually built.

**Why this split exists:** Phase 1 delivers the highest-impact rendering fixes that work within the
existing region-grid architecture (bilinear sampling, logarithmic rays, curvature, hill shading,
extended 120km range). Phase 2 requires a new async tile-cache infrastructure to extend the view
to 250km and unlock per-layer shading at true DEM resolution.

---

## What Phase 1 Already Did

- **Bilinear sampling** — replaced nearest-neighbour `sampleMeshAt` with bilinear interpolation
  on the region grid → smoother ridgelines immediately
- **Logarithmic ray steps** — 1.5% growth from 100m → 120km (~476 steps, vs 120 fixed before)
  → fine detail near viewer, coarser far away, matching human visual acuity
- **Earth curvature + atmospheric refraction correction** — applied at every ray sample; significant
  beyond ~20km; matches PeakFinder/HeyWhatsThat accuracy
- **Hill shading** — computed from finite-difference surface normals on the elevation grid, dotted
  with NW 45° sun direction; creates the layered PeakFinder-style depth effect
- **120km max range** — extended from 35km; matches typical region extent
- **Cascades peaks** — added Washington Cascades peak data + more Colorado peaks
- **Peak culling at 80km** — labels only shown for peaks within meaningful viewing range

---

## Phase 2 Tasks (in priority order)

### P2.1 — Multi-Resolution Tile Cache for SCAN (`src/data/ScanTileCache.ts`) ✅ DONE

**Why:** The existing region grid is 256×256 pixels over ~220km → 860m/pixel effective resolution.
PeakFinder-quality nearby ridgelines require z12/z13 tiles (~28m/pixel). Beyond the region extent,
we need z8/z9 tiles to reach 250km.

**Implementation:**

```typescript
// src/data/ScanTileCache.ts

// Distance → zoom level mapping (from the engineering proposal)
// dist < 5km    → z13  (19m/px — fine foreground detail)
// 5–20km        → z11  (76m/px)
// 20–80km       → z10  (152m/px — region grid already covers this)
// 80–250km      → z9   (305m/px)
// 150–250km     → z8   (610m/px — user wants full 250km view)

export function distanceToZoom(distM: number): number {
  if (distM < 5_000)   return 13
  if (distM < 20_000)  return 11
  if (distM < 80_000)  return 10
  if (distM < 150_000) return 9
  return 8
}

export class ScanTileCache {
  // Decoded Float32Array per tile (keyed "z/x/y")
  private elevGrids = new Map<string, Float32Array>()
  private pending   = new Map<string, Promise<void>>()

  // Bilinear-interpolated elevation at any lat/lng + zoom
  sampleBilinear(lat: number, lng: number, zoom: number): number | null

  // Pre-fetch all tiles needed within radiusM of viewer at given zoom
  async prefetchArea(
    centerLat: number,
    centerLng: number,
    radiusM: number,
    zoom: number,
  ): Promise<void>

  // Convenience: pre-fetch all zoom levels needed for 250km panorama
  async prefetchForViewer(viewerLat: number, viewerLng: number): Promise<void> {
    await Promise.all([
      this.prefetchArea(viewerLat, viewerLng,   5_000, 13),
      this.prefetchArea(viewerLat, viewerLng,  20_000, 11),
      this.prefetchArea(viewerLat, viewerLng, 250_000,  8),
    ])
  }
}
```

**Tile count estimate for 250km panorama:**
- z13 (0–5km): ~4–9 tiles — tiny download, critical for nearby ridgelines
- z11 (5–20km): ~4–9 tiles — sharp mid-range terrain
- z8 (80–250km): ~4–9 tiles — only a few tiles needed (each z8 covers ~120km wide at 40°N)
- Total first-load: ~15–30 tiles; subsequent loads are IndexedDB cache hits

**Tile fetching:** Reuse the existing `loadElevationTile(z, x, y)` from `elevationLoader.ts` — it
already implements the 4-tier fallback (memory → IDB → local → AWS). Decode each `CachedTile` to
`Float32Array` using the existing `decodeTerrarium()` function.

**Integration into ScanScreen.tsx:**

```typescript
// Add tile cache ref:
const scanTileCache = useRef<ScanTileCache>(new ScanTileCache())

// Prefetch on location change:
useEffect(() => {
  setIsPrefetchingTiles(true)
  scanTileCache.current
    .prefetchForViewer(activeLat, activeLng)
    .finally(() => setIsPrefetchingTiles(false))
}, [activeLat, activeLng])

// In ray loop, replace sampleMeshBilinear with:
function sampleBestAvailable(lat, lng, dist, mesh, tileCache): number {
  const zoom = distanceToZoom(dist)
  if (zoom >= 11) {
    // Try high-res tile first
    const hiRes = tileCache.sampleBilinear(lat, lng, zoom)
    if (hiRes !== null) return hiRes
  }
  // Fall back to region grid
  return sampleMeshBilinear(lat, lng, mesh)
}
```

**Extend MAX_DIST from 120km to 250km** once z8 tiles are being fetched.

---

### P2.2 — Web Worker for Skyline Precomputation ✅ DONE

**Why:** With 250km range and ~476 ray samples per column, computing all 360°/0.5° = 720 azimuth
columns takes ~340,000 elevation samples. At 60fps this is negligible, but with the async tile
cache overhead (waiting for z8 tiles), moving computation off the main thread prevents UI freezes.

**SkylineData interface (add to `src/core/types.ts`):**

```typescript
export interface SkylineData {
  /** Elevation angle in radians at each 0.5° azimuth step (720 entries for 360°) */
  angles: Float32Array
  /** Distance to ridgeline in metres (for depth-based shading) */
  distances: Float32Array
  /** Hill-shade value at ridgeline [0–1] */
  shading: Float32Array
  /** Azimuth steps per degree */
  resolution: number
  /** When and where this was computed */
  computedAt: { lat: number; lng: number; elev: number; timestamp: number }
}
```

**Web Worker file (`src/workers/skylineWorker.ts`):**

```typescript
import { loadElevationTile, decodeTerrarium } from '@/data/elevationLoader'

self.onmessage = async (e: MessageEvent<SkylineRequest>) => {
  const { viewerLat, viewerLng, viewerElev, resolution, maxRange } = e.data

  const numAzimuths = Math.round(360 * resolution)
  const angles    = new Float32Array(numAzimuths)
  const distances = new Float32Array(numAzimuths)
  const shading   = new Float32Array(numAzimuths)

  for (let ai = 0; ai < numAzimuths; ai++) {
    const azimuth = ai / resolution  // degrees
    // Run max-slope sweep for this azimuth ...
    // (same logarithmic ray walk as Phase 1, but using ScanTileCache for tiles)
    // Report progress every 45 azimuths:
    if (ai % 45 === 0) {
      self.postMessage({ type: 'progress', progress: ai / numAzimuths })
    }
  }
  self.postMessage({ type: 'complete', skyline: { angles, distances, shading, resolution, ... } })
}
```

**UI loading state:** Show "Computing panorama..." progress bar for ~1–2s on location change.
Pre-warm with a low-resolution pass (2° steps) first, then refine to 0.5°.

---

### P2.3 — Peak Visibility Against Ridgeline (Session 3)

**Why:** Currently, peak labels appear whenever a peak is geometrically within the FOV, even if
it's actually behind a ridge. PeakFinder shows peaks only when they're on or near the ridgeline.

**Algorithm (once SkylineData exists):**

```typescript
function isPeakVisible(
  peak: Peak,
  skyline: SkylineData,
  viewerLat: number, viewerLng: number, viewerElev: number,
): boolean {
  const dist = haversineDistance({ lat: viewerLat, lng: viewerLng },
                                 { lat: peak.lat,  lng: peak.lng }) * 1000  // km → m
  const azimuth = calculateBearing(
    { lat: viewerLat, lng: viewerLng },
    { lat: peak.lat,  lng: peak.lng },
  )
  // Curvature-corrected elevation angle to peak
  const curvDrop = (dist * dist) / (2 * 6_371_000) * (1 - 0.13)
  const peakAngle = Math.atan2(peak.elevation_m - viewerElev - curvDrop, dist)

  // Look up ridgeline angle at this azimuth
  const aziIdx = Math.round(azimuth * skyline.resolution) % skyline.angles.length
  const ridgeAngle = skyline.angles[aziIdx]

  // Peak is visible if its elevation angle is within 0.1° of the ridgeline maximum
  return peakAngle >= ridgeAngle - (0.1 * Math.PI / 180)
}
```

---

### P2.4 — OpenStreetMap Peak Data Integration ✅ DONE

**Why:** The current 30 Colorado + 13 Alaska peaks are hardcoded. For any arbitrary viewpoint
(Viewpoint Selection feature), we need real worldwide peak data.

**API:** OpenStreetMap Overpass API
```
[out:json][timeout:30];
node["natural"="peak"]["ele"]["name"](${south},${west},${north},${east});
out body;
```

**Implementation sketch:**

```typescript
// src/data/peakLoader.ts
export async function fetchPeaksInBounds(bounds: Bounds): Promise<Peak[]> {
  const query = `[out:json][timeout:30];
    node["natural"="peak"]["ele"]["name"]
    (${bounds.south},${bounds.west},${bounds.north},${bounds.east});
    out body;`

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
  })
  const data = await resp.json()
  return data.elements
    .filter((e: any) => e.tags?.ele && e.tags?.name)
    .map((e: any) => ({
      id: `osm-${e.id}`,
      name: e.tags.name,
      lat: e.lat,
      lng: e.lon,
      elevation_m: parseFloat(e.tags.ele),
    }))
    .filter((p: Peak) => p.elevation_m > 0)
}
```

**Cache:** Store fetched peaks in IndexedDB keyed by bounds hash; invalidate after 24h.

---

### P2.5 — Viewpoint Selection (Session 3 — partially enabled)

**Why:** The user explicitly requested this: "Via the menu option 'Viewpoint selection' you can
discover any mountain landscape from a random location in the world."

**Implementation:**
1. Add a "Choose Viewpoint" button in SCAN screen (or MAP screen → sets explore location → syncs SCAN)
2. The `setExploreLocation(lat, lng)` already exists on the MAP screen tap — SCAN already listens
   to `locationStore.activeLat/activeLng`
3. With P2.1 (multi-zoom tile cache), SCAN will fetch tiles for any arbitrary location worldwide —
   not limited to the current loaded region
4. With P2.4 (OSM peaks), peak labels will appear for any location worldwide

---

### P2.6 — Camera AR Overlay Mode

**Design:** When the user taps a "Camera" button, a `<video>` element streams the device camera
behind the terrain canvas. The canvas alpha channel is used for the terrain layer (sky = transparent,
terrain = opaque). Heading comes from `DeviceOrientationEvent.alpha`.

**Key technical concerns:**
- `getUserMedia({ video: { facingMode: 'environment' } })` for rear camera
- `DeviceOrientationEvent` requires HTTPS + permission prompt on iOS 13+
- Canvas compositing: set canvas `globalCompositeOperation = 'destination-over'` for sky transparency

This is a Session 3 feature (per the roadmap) — requires proper HTTPS deployment.

---

## Architecture Diagram After Phase 2

```
ScanScreen
    │
    ├─ ScanTileCache (multi-zoom: z8–z13)
    │       └─ reuses loadElevationTile() fallback chain
    │
    ├─ SkylineWorker (Web Worker)
    │       └─ 360° max-slope sweep → SkylineData
    │
    ├─ SkylineData (precomputed per viewpoint)
    │       ├─ angles Float32Array  (720 entries @ 0.5°/step)
    │       ├─ distances Float32Array
    │       └─ shading Float32Array (hill shade at ridgeline)
    │
    └─ renderFrame() (fast, sync — just reads SkylineData)
            └─ ~1ms per frame, no elevation samples needed
```

---

## Notes on the Phase 1/2 Split

**Phase 1 fixes the root causes** of visual quality:
1. Bilinear sampling → smooth ridgelines from existing data
2. Logarithmic steps → correct near-terrain detail
3. Curvature correction → accurate distant mountains
4. Hill shading → PeakFinder depth aesthetic

**Phase 2 extends capability:**
1. Multi-zoom tiles → true z12 sharpness nearby, 250km range
2. Web Worker → non-blocking precompute for fast panning
3. Peak visibility → hide occluded summits
4. Worldwide viewpoints → break out of the current 3-region limitation

The Phase 1 improvements are immediately visible in the app. Phase 2 improvements are significant
but require more infrastructure work. Prioritize P2.1 (tile cache) + P2.2 (Web Worker) as a unit —
they're tightly coupled.

---

## Phase 2 Implementation Notes (v1.3 — completed 2026-02-24)

### What was built

**`src/data/ScanTileCache.ts`** (new)
- `distanceToZoom(distM)`: z13 (<5km), z11 (<20km), z10 (<80km), z9 (<150km), z8 (250km)
- `ScanTileCache` class: decoded `Float32Array` grids keyed `"z/x/y"`, deduplication via `pending` Map
- `sampleBilinear(lat, lng, zoom)` → `number | null` (null = tile not yet loaded, caller falls back)
- `prefetchForViewer(lat, lng)` → parallel fetch of z13(5km) + z11(20km) + z8(250km) areas
- Reuses `loadElevationTile()` / `decodeTerrarium()` from `elevationLoader.ts`

**`src/data/peakLoader.ts`** (new)
- `fetchPeaksNear(lat, lng, radiusKm)` → Overpass API → `Peak[]` sorted by elevation desc
- IndexedDB cache keyed by 0.1°-rounded bounding box string; 24h TTL
- Handles `ele` tag formats: `"4399"`, `"4399 m"`, `"14440 ft"` — converts ft → m automatically
- On Overpass failure returns `[]`; ScanScreen falls back to hardcoded `terrainStore` peaks

**`src/workers/skylineWorker.ts`** (new)
- `/// <reference lib="webworker" />` for correct TypeScript types
- Worker-safe tile loading: `createImageBitmap(blob)` + `OffscreenCanvas` (no DOM `Image`)
- Phase 1: prefetch z13/z11/z9/z8 tiles for viewer location
- Phase 2: 720-azimuth (0.5°/step) logarithmic ray march per azimuth — max-slope sweep
- Accurate finite-difference hill shade computed at final ridgeline point only (not every step)
- Returns `SkylineData` via transferable `ArrayBuffer` zero-copy: `postMessage(data, [buf1, buf2, buf3])`
- Progress: `{type:'progress', phase, progress}` messages update the HUD loading bar

**`src/core/types.ts`** (additive)
- `SkylineData`: `angles`, `distances`, `shading` Float32Arrays + `resolution`, `numAzimuths`, `computedAt`
- `SkylineRequest`: viewer position + mesh data + resolution + maxRange

**`src/store/cameraStore.ts`** (additive)
- `setFov(fov)` → clamp to [15, 100]
- `applyFovScale(scale)` → `fov = clamp(fov × scale, 15, 100)` — used by pinch gesture handler

**`src/screens/ScanScreen/ScanScreen.tsx`** (major rewrite)
- `MAX_DIST = 250_000` m (was 120,000)
- `sampleBestAvailable()`: tries ScanTileCache at distance-appropriate zoom, falls back to mesh
- `cheapDirectionalShade(bearingDeg)`: O(1) bearing-based shade — `0.4 + cos(bearing−315°)×0.3 + 0.3`
  - Replaces finite-difference hill shade in the real-time ray march (mobile perf requirement)
  - Worker still computes accurate shade offline for the QUICK path
- `drawFromSkyline()`: O(W) render — reads `SkylineData.angles/distances/shading`, no elevation lookups
- `drawScanCanvas()`: routes to `drawFromSkyline` (QUICK) or full ray march (FULL) based on `skylineData`
- Sky: 6-stop gradient `#000810` → `#0f2c42` + 80 deterministic stars in upper 45%
- Horizon glow: 24px gradient + 1px crisp line
- Pinch zoom: `handleTouchStart/Move/End` → `applyFovScale(prevDist/newDist)`
- OSM peaks: `fetchPeaksNear(lat, lng, 130)` on location change; preferred over hardcoded if non-empty
- Peak labels include Earth curvature correction in `projectFirstPerson()`
- `PitchIndicator` component: vertical gauge, marker top% = `50 − (pitch_deg/80)×50`
- Loading progress bar during tile prefetch + worker computation
- FOV badge showing current FOV during and after pinch
- HUD "250KM" green badge when skyline is ready

**`src/screens/ScanScreen/ScanScreen.module.css`** (additions)
- `.loadingOverlay`, `.loadingBar`, `.loadingFill` — progress display
- `.pitchIndicator`, `.pitchTrack`, `.pitchMarker`, `.pitchZero`, `.pitchLabel`
- `.fovBadge`, `.hudReady` (green 250KM indicator)
- Enhanced `.peakDot` pulse animation, `.peakCard` backdrop blur

### Mobile performance decisions
- **No live hill shade**: User explicitly required smooth phone performance. The ray march path uses
  `cheapDirectionalShade(bearingDeg)` (one cosine per column, not 4 elevation lookups per hit).
  The QUICK path reads accurate shade precomputed by the worker.
- **QUICK path O(W)**: Once `SkylineData` is ready, each frame is just a column-by-column array read.
  No elevation sampling at all during pan/heading changes after the first precompute.
- **Worker isolation**: All heavy precomputation runs in `skylineWorker.ts`. Main thread stays responsive.

### What's next (Session 3)
- **P2.3 Peak ridgeline visibility**: `SkylineData.angles` is available — compare peak elevation angle
  to ridgeline angle at that azimuth to filter occluded summits
- **P2.5 Worldwide viewpoints**: OSM peaks (P2.4) + ScanTileCache (P2.1) already enable arbitrary
  locations; wire up a "Change Viewpoint" button in SCAN or MAP
- **Session 3**: Real GPS (`navigator.geolocation`), `DeviceOrientationEvent` magnetometer for
  heading, HTTPS deployment for camera AR overlay
