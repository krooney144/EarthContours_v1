# EarthContours — Regional Data System Implementation Plan

## Background & Goals

EarthContours is a terrain visualization web app (React + TypeScript + Vite) with 4 screens: SCAN (AR panorama), EXPLORE (3D orbit), MAP (globe + flat DEM), and SETTINGS. It currently has:

- **3 hand-defined regions** in `src/data/regions.ts`: Colorado Rockies (~220×250 km), Alaska Range (~255×220 km), Washington Cascades (~230×220 km). Each region is `{ id, name, center: {lat,lng}, bounds: {north,south,east,west}, description }`.
- **Live OSM Overpass peak loading** via `src/data/peakLoader.ts` — queries `natural=peak` nodes with `ele` + `name` tags, cached 24h in IndexedDB (`ec-peaks-v1`). Returns `Peak { id, name, lat, lng, elevation_m, isHighPoint? }`. Falls back to hardcoded peaks in `src/data/simulatedData.ts` (36 Colorado, 17 Alaska, 11 Cascades).
- **Natural Earth global vector layers** via `src/data/geoLoader.ts` + `src/data/geoManager.ts` — rivers (7.3 MB), lakes (5.0 MB), glaciers (5.9 MB), coastline (10.1 MB) as GeoJSON in `/public/geo/`. 3-tier cache: memory → IndexedDB (`ec-geo-v1`) → fetch. Converted to app types (`River[]`, `WaterBody[]`, `Glacier[]`, `Coastline[]`).
- **OSM water polygons** via `src/data/waterLoader.ts` — Overpass query for `natural=water` with `name` tag, cached 24h in IndexedDB. Used on flat MAP at zoom 7+.
- **AWS Terrarium elevation tiles** via `src/data/elevationLoader.ts` — 4-tier fallback (memory → IndexedDB `ec-elevation-v1` → local `/tiles/` → AWS S3). Terrarium RGB encoding: `elev = R×256 + G + B/256 − 32768`.
- **SCAN tile cache** via `src/data/ScanTileCache.ts` — multi-zoom (z8–z15) with distance-based zoom selection.

### What We're Building

A **regional data bundle system** that provides richer, faster, offline-capable peak and water feature data for specific geographic regions. The system layers on top of the existing Natural Earth global data:

```
Always loaded (~29 MB):
  └── Natural Earth 1:10m: rivers, lakes, glaciers, coastlines
      └── Sufficient for z1–z8 on MAP, provides global coverage

Downloaded per-region (~2–10 MB each):
  └── Pre-built peak database (OSM names + Kirmse prominence data)
  └── OSM water features at full detail
  └── Replaces live Overpass queries when available
  └── Cached permanently in IndexedDB
```

### Region Design Philosophy

- **Follow terrain, not political boundaries.** "Colorado Rockies" extends into southern Wyoming (Medicine Bow), northern New Mexico (Sangre de Cristos), and eastern Utah (La Sals).
- **Generous overlap at seams.** Adjacent regions share 30–50 km of overlap. Peaks deduplicated by lat/lng proximity (~100m). Elevation tiles already cached by z/x/y so shared tiles auto-reuse.
- **~200–300 km per side.** Large ranges split into sections (e.g., "Rockies: Colorado" / "Rockies: Wyoming" / "Rockies: Montana"). Keeps flat-earth error < 50m.
- **Uncovered areas still work.** Natural Earth global layers + live Overpass queries remain the fallback. Regional data is an enhancement, not a requirement.

### Key Data Sources

- **Peaks:** Andrew Kirmse's prominence dataset (7.8M peaks worldwide, CSV, free) merged with OSM `natural=peak` for names. Kirmse provides elevation + prominence computed from actual DEM data. CSV format: `lat, lng, elevation_ft, key_saddle_lat, key_saddle_lng, prominence_ft`.
- **Water features:** OSM Overpass bulk export for the region bounds — `natural=water` ways+relations with geometry.
- **Peak database (OSM):** ~1.2–1.5M `natural=peak` nodes worldwide via Overpass or Geofabrik extracts.

---

## Session 1: Region Catalog & Data Types

### Context
Currently `src/data/regions.ts` defines 3 regions as simple bounding boxes. We need to expand this into a rich catalog of ~15–20 initial regions covering major mountain areas worldwide, with metadata to support download management.

### Tasks

**1.1 — Expand the `Region` type** in `src/core/types.ts`:
```typescript
interface RegionDataManifest {
  peakCount: number
  waterFeatureCount: number
  bundleSizeBytes: number
  lastUpdated: string  // ISO date
}

// Extend existing Region interface:
interface Region {
  id: string
  name: string
  center: LatLng
  bounds: { north: number; south: number; east: number; west: number }
  description: string
  // New fields:
  group?: string              // e.g., "Rocky Mountains", "Alps", "Himalayas"
  parentRange?: string        // human-readable parent range name
  manifest?: RegionDataManifest  // populated after fetching manifest
}
```

**1.2 — Build the initial region catalog** in `src/data/regions.ts`. Define ~15–20 regions. Each region should be ~200–300 km per side, follow terrain not political boundaries, and overlap adjacent regions by 30–50 km. Suggested initial set:

**North America:**
- `colorado-rockies` (existing, verify bounds extend into S. Wyoming + N. New Mexico + E. Utah)
- `wyoming-rockies` (Wind Rivers, Tetons, Absarokas, Bighorns — overlap Colorado by ~40 km)
- `montana-rockies` (Glacier NP, Bob Marshall, Beartooths — overlap Wyoming by ~30 km)
- `wa-cascades` (existing, verify extends into S. BC and N. Oregon)
- `sierra-nevada` (Whitney to Tahoe)
- `alaska-range` (existing, verify bounds)
- `appalachian-south` (Smokies, Blue Ridge)
- `alaska-range` (existing)

**Europe:**
- `alps-west` (Mont Blanc, Matterhorn, Bernese Oberland)
- `alps-east` (Dolomites, Austrian Alps, Grossglockner)
- `pyrenees` (full range, France–Spain border)
- `scottish-highlands` (Ben Nevis, Cairngorms)
- `scandinavian-mountains` (Jotunheimen, Galdhøpiggen)

**Asia:**
- `himalayas-everest` (Khumbu region, Everest–Cho Oyu–Makalu)
- `himalayas-annapurna` (Annapurna, Dhaulagiri, Manaslu)
- `japanese-alps` (Northern/Central/Southern Alps, Honshu)

**Southern Hemisphere:**
- `southern-alps-nz` (Aoraki/Mt Cook, Fox Glacier region)
- `patagonia` (Torres del Paine, Fitz Roy)

**1.3 — Add a `RegionGroup` helper** for UI grouping:
```typescript
const REGION_GROUPS: { name: string; regionIds: string[] }[]
```

**1.4 — Verify all existing region references still work.** The 3 current regions must keep their exact `id` values. Any code referencing `REGIONS` or `REGION_MAP` should work unchanged.

### Acceptance Criteria
- `npm run type-check` passes
- `npm run build` succeeds
- All 3 existing regions present with same IDs
- 15+ new regions defined with reasonable bounds
- Adjacent regions overlap by 30–50 km at shared boundaries

---

## Session 2: Region Data Bundle Generator (Node Script)

### Context
We need a one-time (re-runnable) Node.js script that generates a JSON data bundle for each region. This script runs locally on a developer machine, NOT in the browser. Output files go into `/public/geo/regions/` and are served as static assets.

### Tasks

**2.1 — Create `scripts/generate-region-data.ts`** (Node.js script, runs with `tsx`):

For each region in the catalog:
1. **Fetch OSM peaks** via Overpass API:
   ```
   [out:json][timeout:60];
   node["natural"="peak"]["name"](south,west,north,east);
   out body;
   ```
   (Note: fetch ALL peaks with `name`, not just those with `ele` — we'll fill elevation from Kirmse data)

2. **Load Kirmse prominence data** from a local CSV file (user downloads once from https://www.andrewkirmse.com/prominence — the "World" file). Parse CSV: `lat, lng, elevation_ft, key_saddle_lat, key_saddle_lng, prominence_ft`.

3. **Merge peaks:**
   - For each OSM peak, find nearest Kirmse peak within 500m
   - If matched: use OSM name + Kirmse elevation/prominence (Kirmse elevation is DEM-derived, more consistent than user-entered OSM `ele` tags)
   - If OSM peak has no Kirmse match: keep OSM data, prominence = null
   - If Kirmse peak has no OSM match but prominence ≥ 300ft (significant peak): include as unnamed peak
   - Deduplicate: if two OSM peaks match the same Kirmse peak, keep the one with closer coordinates

4. **Fetch OSM water features** via Overpass:
   ```
   [out:json][timeout:60];
   (
     way["natural"="water"]["name"](south,west,north,east);
     relation["natural"="water"]["name"](south,west,north,east);
   );
   out body;
   >;
   out skel qt;
   ```

5. **Output a single JSON file** per region at `/public/geo/regions/{region-id}.json`:
   ```json
   {
     "regionId": "colorado-rockies",
     "generatedAt": "2026-03-10T00:00:00Z",
     "peaks": [
       {
         "id": "osm-12345",
         "name": "Mount Elbert",
         "lat": 39.1178,
         "lng": -106.4453,
         "elevation_m": 4401.2,
         "prominence_m": 2764.9,
         "isHighPoint": false
       }
     ],
     "waterBodies": [
       {
         "id": "osm-way-67890",
         "name": "Turquoise Lake",
         "type": "lake",
         "center": { "lat": 39.25, "lng": -106.35 },
         "polygon": [{ "lat": 39.24, "lng": -106.36 }, ...]
       }
     ]
   }
   ```

6. **Generate a manifest file** at `/public/geo/regions/manifest.json`:
   ```json
   {
     "generatedAt": "2026-03-10T00:00:00Z",
     "regions": {
       "colorado-rockies": {
         "peakCount": 4832,
         "waterFeatureCount": 245,
         "bundleSizeBytes": 3200000,
         "lastUpdated": "2026-03-10T00:00:00Z"
       }
     }
   }
   ```

**2.2 — Add npm scripts:**
```json
"generate:regions": "tsx scripts/generate-region-data.ts",
"generate:region": "tsx scripts/generate-region-data.ts --region colorado-rockies"
```

**2.3 — Rate-limit Overpass queries** (max 1 request per 5 seconds, retry with backoff on 429/503). The script should be resumable — skip regions that already have up-to-date output files.

**2.4 — Generate the Colorado Rockies bundle first** as a test. Verify:
- Peak count is reasonable (expect 2,000–5,000 with Kirmse unnamed peaks)
- Named peaks include all 53 fourteeners
- Water features include major reservoirs (Dillon, Turquoise Lake, etc.)
- File size is < 10 MB

### Acceptance Criteria
- Script runs successfully: `npm run generate:region -- --region colorado-rockies`
- Output file exists at `/public/geo/regions/colorado-rockies.json`
- Manifest file exists at `/public/geo/regions/manifest.json`
- JSON is valid and matches the schema above
- Colorado Rockies bundle has 1,000+ peaks and 100+ water features

### Dependencies
- `tsx` (dev dependency for running TypeScript scripts in Node)
- User must download Kirmse CSV to `data/kirmse-peaks.csv` (not committed to repo — too large)
- Internet access for Overpass API

---

## Session 3: Regional Data Loader (Browser Runtime)

### Context
Now we need the browser-side code to fetch, cache, and serve regional data bundles. This integrates with the existing IndexedDB caching pattern used by `elevationLoader.ts` and `geoLoader.ts`.

### Tasks

**3.1 — Create `src/data/regionDataLoader.ts`:**

```typescript
// 3-tier cache: memory → IndexedDB → fetch
// IndexedDB: database "ec-regions-v1", store "bundles"
// Cache key: region ID (e.g., "colorado-rockies")
// No TTL — bundles are versioned by generatedAt timestamp

interface RegionDataBundle {
  regionId: string
  generatedAt: string
  peaks: Peak[]            // reuse existing Peak type, add prominence_m
  waterBodies: WaterBody[] // reuse existing WaterBody type
}

// Public API:
loadRegionData(regionId: string): Promise<RegionDataBundle | null>
isRegionDataAvailable(regionId: string): Promise<boolean>
getRegionManifest(): Promise<RegionManifest>
clearRegionData(regionId: string): Promise<void>
getDownloadedRegions(): Promise<string[]>
```

**3.2 — Add `prominence_m` to the `Peak` type** in `src/core/types.ts`:
```typescript
interface Peak {
  id: string
  name: string
  lat: number
  lng: number
  elevation_m: number
  isHighPoint?: boolean
  prominence_m?: number  // NEW — from Kirmse data, null for unmatched OSM peaks
}
```
Ensure this doesn't break any existing code (prominence_m is optional).

**3.3 — Create a `RegionDataProvider` integration layer** in `src/data/regionDataProvider.ts`:

This is the key integration point. It provides a unified API that checks for regional data first, then falls back to live Overpass / Natural Earth:

```typescript
// Peaks: regional bundle → Overpass fallback
fetchPeaksForLocation(lat: number, lng: number, radiusKm: number): Promise<Peak[]>

// Water: regional bundle → waterLoader fallback → Natural Earth fallback
fetchWaterForBounds(bounds: {north,south,east,west}): Promise<WaterBody[]>

// Which region (if any) covers this location?
findRegionForLocation(lat: number, lng: number): Region | null
```

Logic for `fetchPeaksForLocation`:
1. Find which region(s) cover the lat/lng (check all region bounds)
2. If a region is found AND its data bundle is cached → filter peaks by radius, return
3. If a region is found but NOT cached → fall through to live Overpass (existing `peakLoader.ts`)
4. If no region covers the location → fall through to live Overpass

Same pattern for water features.

**3.4 — Wire `RegionDataProvider` into existing consumers:**

- `src/screens/ScanScreen.tsx` (or wherever `fetchPeaksNear` is called) — replace direct `peakLoader` calls with `regionDataProvider.fetchPeaksForLocation`
- `src/screens/MapScreen.tsx` (or wherever water features are loaded) — replace direct `waterLoader` calls with `regionDataProvider.fetchWaterForBounds`
- Keep the existing loaders (`peakLoader.ts`, `waterLoader.ts`) intact as fallbacks — do NOT delete them

**3.5 — Add region data status to the terrain store** in `src/store/terrainStore.ts`:
```typescript
// New fields:
downloadedRegions: string[]           // IDs of regions with cached bundles
activeRegionId: string | null         // Region covering current location
regionDataLoading: boolean
// New actions:
downloadRegionData(regionId: string): Promise<void>
deleteRegionData(regionId: string): Promise<void>
refreshDownloadedRegions(): Promise<void>
```

### Acceptance Criteria
- `npm run type-check` passes
- `npm run build` succeeds
- When Colorado Rockies bundle exists in `/public/geo/regions/`, peaks load from bundle (no Overpass call)
- When bundle doesn't exist, falls back to Overpass seamlessly
- Peaks from bundle include `prominence_m` values
- No regressions in SCAN, MAP, or EXPLORE screens

---

## Session 4: Settings UI — Region Management

### Context
Users need a way to browse available regions, see which are downloaded, download new ones, and delete old ones. This goes in the SETTINGS screen.

### Tasks

**4.1 — Create a `RegionManager` component** (`src/components/RegionManager.tsx` + `RegionManager.module.css`):

Features:
- List of all regions from the catalog, grouped by `group` field (e.g., "Rocky Mountains", "Alps")
- Each region shows: name, description, peak count, water feature count, bundle size
- Download status: "Not downloaded" / "Downloading..." (with progress) / "Downloaded (3.2 MB)"
- Download button (fetches `/public/geo/regions/{id}.json`, caches to IndexedDB)
- Delete button (clears from IndexedDB)
- Current-location region highlighted (if GPS available)
- Storage summary at top: "3 regions downloaded, 12.4 MB total"

**4.2 — Add `RegionManager` to the Settings screen.** Place it in a new section below existing settings. Section header: "Terrain Regions" or "Offline Data".

**4.3 — Style with existing CSS system.** Use CSS Modules, ocean-depth palette from `palette.css`, match existing Settings screen patterns.

**4.4 — Add a settings toggle:** `"autoDownloadRegion"` (boolean, default true) — when enabled, automatically download the region bundle for the user's current GPS location on first visit. Store in `settingsStore` (persisted to localStorage).

### Acceptance Criteria
- Region list renders with all catalog regions
- Download/delete buttons work
- Downloaded regions persist across page reloads (IndexedDB)
- Auto-download toggle visible in settings
- Mobile-responsive layout
- No regressions

---

## Session 5: MAP Screen Integration — Contextual Download Prompt

### Context
When a user pans the MAP to an area covered by an available (but not yet downloaded) region, show a subtle prompt to download it.

### Tasks

**5.1 — Add region boundary visualization on MAP** at zoom 7+:
- Draw a subtle dashed outline around available regions on the flat map
- Downloaded regions: solid outline in accent color
- Not-downloaded regions: dashed outline in muted color
- Only show regions visible in the current viewport

**5.2 — Add a contextual download banner:**
- When the map center falls within a non-downloaded region's bounds, show a bottom banner:
  `"Colorado Rockies — 4,832 peaks, detailed water (3.2 MB) [Download]"`
- Banner slides in/out smoothly
- Tapping "Download" triggers the download and shows progress
- Banner dismisses after download completes or if user swipes it away
- Don't show if user has dismissed this region's banner in the current session

**5.3 — Show regional water features on MAP when available:**
- At zoom 9+, if the current viewport overlaps a downloaded region, render regional water bodies instead of (or in addition to) Natural Earth lakes
- Regional water polygons are higher detail than Natural Earth — they should visually "pop in" as the user zooms past z8–z9
- Use same rendering style as existing lake polygons (semi-transparent blue)

**5.4 — Auto-download on GPS location** (if `autoDownloadRegion` setting is enabled):
- On first MAP load with GPS, check if current location falls in a catalog region
- If yes and not downloaded, auto-download in background
- Show a small toast: "Downloading Colorado Rockies terrain data..."

### Acceptance Criteria
- Region outlines visible on flat MAP at zoom 7+
- Download banner appears when panning to non-downloaded region
- Regional water features render at zoom 9+ for downloaded regions
- Auto-download works with GPS
- No performance regression on MAP (don't check regions on every frame — debounce)

---

## Session 6: SCAN Screen Integration — Prominence-Based Peak Filtering

### Context
With regional data, SCAN now has access to thousands of peaks with prominence values. Use prominence to improve peak selection — show the most significant peaks, not just the nearest.

### Tasks

**6.1 — Update peak selection logic in SCAN** to use prominence when available:

Current logic (in ScanScreen or wherever peaks are filtered for display): selects up to 8 visible peaks, deduplicates by horizontal distance. Improve to:
- If peaks have `prominence_m`: sort by prominence descending, then filter for visibility
- Minimum prominence threshold based on distance: nearby peaks (< 20 km) show at 100m+ prominence, mid-range (20–80 km) at 300m+, far (> 80 km) at 500m+
- Still cap at 8 labels, still deduplicate horizontally
- If peaks lack prominence data (Overpass fallback): use existing elevation-based logic unchanged

**6.2 — Add prominence display to peak labels** (optional, behind debug toggle):
- In debug mode, show prominence in the peak label: "Mt. Elbert (14,440 ft / P: 9,093 ft)"
- In normal mode, labels unchanged

**6.3 — Update peak refinement** (`refine-peaks` worker message):
- When sending peaks to worker for refinement, prioritize by prominence
- If > 8 peaks visible, refine only the top 8 by prominence (don't waste worker cycles on minor bumps)

### Acceptance Criteria
- SCAN shows more meaningful peaks (high-prominence peaks preferred over nearby minor bumps)
- No change in behavior when regional data is not available (fallback path unchanged)
- Peak label count still capped at 8
- Debug panel shows prominence values when available

---

## Session 7: Polish, Testing & Bundle Generation for All Regions

### Context
All the infrastructure is built. This session generates data for all catalog regions, tests edge cases, and polishes the UX.

### Tasks

**7.1 — Run the generator script for all catalog regions:**
```bash
npm run generate:regions
```
- Expect this to take 30–60 minutes (Overpass rate limiting)
- Verify each output file
- Log total sizes

**7.2 — Test edge cases:**
- User at a location NOT in any region (e.g., Kansas) — should fall back to Overpass gracefully
- User at the overlap between two regions — should merge peaks, deduplicate
- Region bundle fetch fails (offline, 404) — should fall back to Overpass
- Very large region (Himalayas) — verify bundle size is reasonable (< 15 MB)
- Region with no named peaks (unlikely but handle gracefully)

**7.3 — Performance audit:**
- Measure time to load peaks from regional bundle vs. Overpass (expect 10–50× faster)
- Measure IndexedDB read time for a large bundle (should be < 200ms)
- Verify MAP doesn't lag when drawing region outlines for 15+ regions
- Verify SCAN startup isn't slower with regional data

**7.4 — Update CLAUDE.md** with:
- New data architecture (regional bundles)
- How to add a new region (add to catalog + run generator)
- Data source credits (Kirmse, OSM, Natural Earth)
- New npm scripts

**7.5 — Commit structure:**
- One commit per major feature area (types, generator, loader, UI, integrations)
- Clear commit messages referencing this plan

### Acceptance Criteria
- All catalog regions have generated bundles
- All bundles load correctly in the app
- No regressions across all 4 screens
- CLAUDE.md updated
- `npm run type-check && npm run build` passes

---

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `scripts/generate-region-data.ts` | Node script to generate regional data bundles |
| `src/data/regionDataLoader.ts` | Browser-side bundle fetch + IndexedDB cache |
| `src/data/regionDataProvider.ts` | Unified API: regional data → fallback to Overpass |
| `src/components/RegionManager.tsx` | Settings UI for browsing/downloading regions |
| `src/components/RegionManager.module.css` | Styles for region manager |
| `public/geo/regions/manifest.json` | Generated manifest of all region bundles |
| `public/geo/regions/{id}.json` | Generated data bundles (one per region) |

### Modified Files
| File | Changes |
|------|---------|
| `src/core/types.ts` | Add `prominence_m` to `Peak`, add `RegionDataManifest` |
| `src/data/regions.ts` | Expand from 3 to 15–20 regions, add `group`/`parentRange` fields |
| `src/store/terrainStore.ts` | Add region download state + actions |
| `src/store/settingsStore.ts` | Add `autoDownloadRegion` toggle |
| `src/screens/MapScreen.tsx` | Region outlines, download banner, regional water rendering |
| `src/screens/ScanScreen.tsx` | Use `regionDataProvider` for peaks, prominence-based filtering |
| `src/screens/SettingsScreen.tsx` | Add `RegionManager` component |
| `package.json` | Add `tsx` dev dependency, `generate:regions` scripts |
| `CLAUDE.md` | Document regional data architecture |

### Unchanged Files (used as fallbacks)
| File | Role |
|------|------|
| `src/data/peakLoader.ts` | Overpass peak fallback — kept intact |
| `src/data/waterLoader.ts` | Overpass water fallback — kept intact |
| `src/data/geoLoader.ts` | Natural Earth global layers — kept intact |
| `src/data/geoManager.ts` | Natural Earth parsing — kept intact |
| `src/data/simulatedData.ts` | Hardcoded peak fallback — kept intact |

---

## Estimated Bundle Sizes

| Region | Peaks (est.) | Water Features (est.) | Bundle Size (est.) |
|--------|-------------|----------------------|-------------------|
| Colorado Rockies | 3,000–5,000 | 200–400 | 2–5 MB |
| Alps West | 4,000–6,000 | 300–500 | 3–6 MB |
| Himalayas Everest | 2,000–4,000 | 50–150 | 2–4 MB |
| Sierra Nevada | 2,000–4,000 | 150–300 | 2–4 MB |
| Japanese Alps | 1,500–3,000 | 100–200 | 1–3 MB |

Total for all ~18 regions: estimated 40–80 MB of static assets. Individual downloads are small enough for mobile.
