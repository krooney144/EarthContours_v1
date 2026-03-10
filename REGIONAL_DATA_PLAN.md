# Regional Data Plan — EarthContours v1

## The Problem

Natural Earth data is **1:10m** — the highest resolution it offers (~29 MB total). Past z8-9, lakes look blocky, rivers simplify into straight lines, and coastlines lose their character. This is structural — Natural Earth is world-atlas data, not regional hiking data.

Meanwhile, peaks come from **live Overpass queries** — fragile (API availability, rate limits), slow on first load, and limited to what OSM has tagged (no prominence data).

Both problems are solved by **pre-built regional data bundles**.

---

## Architecture: Two-Tier Geographic Data

```
TIER 1 — Natural Earth (always loaded, ~29 MB)
├── coastline.json    9.7 MB   Global coastlines
├── rivers.json       7.0 MB   Global rivers (1462 features)
├── glaciers.json     5.7 MB   Global glaciated areas
├── lakes.json        4.9 MB   Global lakes
├── ocean.json        1.4 MB   Ocean boundaries
└── Good enough for z1–z8. Stays exactly as-is.

TIER 2 — Regional Bundles (downloaded per-region, ~2-10 MB each)
├── Detailed OSM water (lakes, rivers, reservoirs)
├── Kirmse + OSM merged peaks (elevation + prominence + name)
├── OSM coastline detail (coastal regions only)
└── Takes over rendering at z8+ when available
```

Natural Earth is never removed. Regional data **overlays** it — when a region is loaded, the MAP renderer uses regional features at z8+ and Natural Earth below z8.

---

## Data Sources

### Peaks: Kirmse Prominence Dataset + OSM Names

**Andrew Kirmse's dataset** (https://github.com/akirmse/mountains):
- 7.8 million peaks worldwide with computed prominence
- Derived from 30m Copernicus DEM (latest version) and 90m SRTM
- Freely downloadable CSV: `lat, lng, elevation_m, prominence_m, isolation_km`
- No names — purely computational

**OpenStreetMap peaks** (~1.2-1.5M worldwide):
- Have names, sometimes elevation, rarely prominence
- Queryable via Overpass (offline export for pipeline)

**Merge strategy**: For each region, spatial-join Kirmse points with OSM peaks within 200m. Result: peaks with **elevation + prominence + name** (where OSM has a name). Unnamed Kirmse peaks still included for SCAN rendering (prominence-filtered).

**Per-region volume**: A dense mountain region (Alps, Rockies) might have 2,000-5,000 peaks with >30m prominence. At ~100 bytes/peak in JSON, that's 200-500 KB. Lightweight.

**SCAN integration**: The prominence field enables much smarter peak selection — instead of "nearest 8 peaks by distance," SCAN can show "8 most prominent peaks visible from this viewpoint." A 300m-prominence peak 80km away is more interesting than a 30m bump 2km away.

### Water: OSM Full Detail

**Lakes/reservoirs**: Polygon geometries from OSM `natural=water` + `water=lake|reservoir`
**Rivers**: LineString geometries from OSM `waterway=river|stream|canal`
**Detail level**: OSM water polygons have 10-100x more vertices than Natural Earth equivalents

**Per-region volume**: Water is the big one. Complex lake shorelines (fjords, reservoirs with fingers) can be 1-3 MB per region. Rivers add another 0.5-2 MB. Total water: 1.5-5 MB per region.

### Coastlines (coastal regions only)

OSM coastline detail for regions that touch the ocean. Not needed for landlocked regions like Colorado. ~0.5-2 MB when present.

---

## Region Catalog

### Design Principles

1. **Mountain-range regions**, not political boundaries — "Swiss Alps" not "Switzerland"
2. **200-500 km per side** — sweet spot for file size and user relevance
3. **Terrain-focused** — every region should have interesting topography
4. **Global coverage of major ranges** — not just US peaks
5. **Overlap is fine** — shared tiles auto-deduplicate in IndexedDB

### Initial Catalog (~40 regions)

#### North America (12)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `colorado-rockies` | Colorado Rockies | 38.0-40.3°N, 107.9-104.9°W | 53 fourteeners, existing region |
| `alaska-range` | Alaska Range — Denali | 62.0-64.1°N, 153.5-148.5°W | Denali 6190m, existing region |
| `wa-cascades` | Washington Cascades | 46.0-49.0°N, 122.5-120.0°W | Rainier, Baker, existing in hardcoded peaks |
| `sierra-nevada` | Sierra Nevada | 36.0-39.0°N, 120.5-117.5°W | Whitney 4421m, Yosemite |
| `tetons-yellowstone` | Tetons & Yellowstone | 43.0-45.5°N, 111.5-109.0°W | Grand Teton, geysers |
| `glacier-np` | Glacier & Bob Marshall | 47.5-49.0°N, 114.5-112.5°W | Northern Rockies |
| `canadian-rockies` | Canadian Rockies | 50.5-52.5°N, 117.5-115.0°W | Robson, Columbia Icefield |
| `bc-coast-range` | BC Coast Range | 49.0-51.5°N, 125.5-122.0°W | Waddington, coastal glaciers |
| `appalachian-north` | Northern Appalachians | 43.5-45.5°N, 72.0-70.5°W | Whites, Presidentials |
| `appalachian-south` | Southern Appalachians | 35.0-36.5°N, 84.0-82.0°W | Smokies, Blue Ridge |
| `hawaii-volcanoes` | Hawaiian Volcanoes | 18.8-20.3°N, 156.5-154.8°W | Mauna Kea 4207m, Kilauea |
| `mexico-volcanoes` | Trans-Mexican Volcanoes | 18.5-19.8°N, 99.5-97.0°W | Orizaba 5636m, Popocatépetl |

#### South America (4)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `patagonia` | Patagonia — Fitz Roy | -51.5 to -48.5°N, 74.0-70.5°W | Torres del Paine, glaciers |
| `central-andes` | Central Andes — Aconcagua | -34.0 to -31.5°N, 71.0-69.0°W | Aconcagua 6961m |
| `peru-andes` | Cordillera Blanca | -10.0 to -8.5°N, 78.0-76.5°W | Huascarán 6768m |
| `ecuador-volcanoes` | Ecuador Volcanoes | -2.0 to 0.5°N, 79.5-77.5°W | Chimborazo, Cotopaxi |

#### Europe (8)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `swiss-alps` | Swiss Alps | 46.0-47.5°N, 6.5-10.5°E | Matterhorn, Eiger, Jungfrau |
| `french-alps` | French Alps — Mont Blanc | 44.5-46.5°N, 5.5-7.5°E | Mont Blanc 4808m |
| `austrian-alps` | Austrian Alps — Tyrol | 46.5-47.5°N, 10.0-13.0°E | Grossglockner |
| `dolomites` | Dolomites | 46.0-47.0°N, 11.0-12.5°E | Marmolada, Tre Cime |
| `pyrenees` | Pyrenees | 42.0-43.0°N, 1.0°W-2.0°E | Aneto 3404m |
| `scottish-highlands` | Scottish Highlands | 56.5-58.0°N, 6.0-4.0°W | Ben Nevis, Cairngorms |
| `scandinavia-jotunheimen` | Jotunheimen & Lofoten | 61.0-62.5°N, 7.0-9.0°E | Galdhøpiggen 2469m |
| `iceland-highlands` | Iceland Highlands | 63.5-66.0°N, 22.0-15.0°W | Hvannadalshnúkur, volcanic |

#### Asia (7)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `everest-region` | Everest & Khumbu | 27.0-28.5°N, 86.0-87.5°E | Everest 8849m, Lhotse, Makalu |
| `annapurna-region` | Annapurna & Dhaulagiri | 28.0-29.0°N, 83.0-84.5°E | Annapurna 8091m |
| `karakoram` | Karakoram — K2 | 35.0-37.0°N, 75.0-77.5°E | K2 8611m, glaciers |
| `japan-alps` | Japanese Alps | 35.5-37.0°N, 137.0-138.5°E | Kita-dake, Hotaka |
| `kamchatka` | Kamchatka Volcanoes | 52.0-56.0°N, 157.0-161.0°E | Klyuchevskaya 4750m |
| `taiwan-mountains` | Taiwan Central Range | 23.0-24.5°N, 120.5-121.5°E | Jade Mountain 3952m |
| `borneo-kinabalu` | Borneo — Mt Kinabalu | 5.5-6.5°N, 116.0-117.0°E | Kinabalu 4095m |

#### Africa (3)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `kilimanjaro` | Kilimanjaro & Meru | -3.8 to -2.8°N, 36.0-37.5°E | Kilimanjaro 5895m |
| `atlas-mountains` | High Atlas | 30.5-32.0°N, 8.5-6.0°W | Toubkal 4167m |
| `drakensberg` | Drakensberg | -30.0 to -28.5°N, 28.5-30.0°E | Thabana Ntlenyana 3482m |

#### Oceania (3)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `nz-southern-alps` | NZ Southern Alps | -44.5 to -42.5°N, 169.5-172.0°E | Aoraki/Mt Cook 3724m |
| `snowy-mountains` | Snowy Mountains NSW | -37.0 to -35.5°N, 148.0-149.5°E | Kosciuszko 2228m |
| `png-highlands` | PNG Highlands | -6.5 to -5.0°N, 144.5-146.0°E | Wilhelm 4509m |

#### Antarctica (1)
| ID | Name | Approx Bounds | Notable |
|----|------|--------------|---------|
| `antarctic-peninsula` | Antarctic Peninsula | -66.0 to -62.0°N, 64.0-58.0°W | Vinson nearby, research stations |

**Total: ~38 regions.** Can expand as needed. Regions don't need to cover flat terrain — nobody downloads "Kansas Plains."

---

## Build Pipeline (Offline, Developer-Run)

A Node.js script suite in `scripts/build-regions/` that generates static JSON files. Run locally or in CI. **Never runs in the user's browser.**

### Pipeline Steps

```
1. DOWNLOAD RAW DATA (one-time)
   ├── Kirmse CSV → scripts/raw/kirmse-peaks.csv (~300 MB uncompressed)
   ├── OSM planet peaks extract → scripts/raw/osm-peaks.json
   │   (via Overpass or OSM PBF extract — one big query, not per-region)
   └── Store in scripts/raw/ (gitignored)

2. FOR EACH REGION IN CATALOG:
   ├── a. PEAKS
   │   ├── Filter Kirmse CSV to region bounds
   │   ├── Filter to prominence ≥ 30m (removes noise, keeps terrain features)
   │   ├── Spatial-join with OSM peaks (200m radius match)
   │   ├── Merge: Kirmse elevation+prominence + OSM name
   │   └── Output: peaks[] array
   │
   ├── b. WATER
   │   ├── Query Overpass for region bounds (or use pre-downloaded PBF)
   │   │   natural=water (lakes, reservoirs)
   │   │   waterway=river|stream (major watercourses)
   │   ├── Simplify geometries for very complex polygons (Douglas-Peucker)
   │   ├── Keep name, type, area (for rendering priority)
   │   └── Output: lakes[], rivers[] arrays
   │
   ├── c. COASTLINE (if coastal)
   │   ├── Extract OSM coastline within bounds
   │   └── Output: coastlines[] array
   │
   └── d. BUNDLE
       ├── Combine into single JSON file:
       │   {
       │     id: "swiss-alps",
       │     version: 1,
       │     bounds: { north, south, east, west },
       │     generated: "2026-03-10",
       │     peaks: [...],
       │     lakes: [...],
       │     rivers: [...],
       │     coastlines: [...],    // only if coastal
       │     stats: { peakCount, lakeCount, riverCount, fileSizeKB }
       │   }
       ├── Output to public/geo/regions/{id}.json
       └── Generate manifest: public/geo/regions/manifest.json

3. GENERATE MANIFEST
   └── manifest.json = catalog of all available regions:
       [
         {
           id: "swiss-alps",
           name: "Swiss Alps",
           bounds: {...},
           peakCount: 3847,
           highestPeak: "Mont Blanc",
           highestElevation: 4808,
           fileSizeKB: 4200,
           hasCoastline: false,
           version: 1
         },
         ...
       ]
```

### Why Offline Pipeline, Not Live

- **Zero runtime API dependency** — app works offline after initial download
- **Consistent data** — every user gets the same verified dataset
- **No Overpass rate limits** — pipeline runs once, result serves everyone
- **Quality control** — you inspect the output before shipping
- **Smaller per-request size** — data is pre-filtered and optimized

---

## File Format Decision: GeoJSON (Not TopoJSON)

**GeoJSON** for now:
- Zero additional dependencies (no topojson-client library needed)
- Matches existing `geoLoader.ts` / `geoManager.ts` patterns exactly
- Regional files are 2-10 MB — acceptable without topology compression
- Simpler to inspect and debug

**Reconsider TopoJSON** if/when:
- Total regional data exceeds 100 MB hosted
- Users downloading 5+ regions at once becomes common
- At that point, adding ~10 KB of topojson-client is justified

---

## App Integration

### New Files

```
src/data/regionalLoader.ts     — Load/cache regional bundles (3-tier like geoLoader)
src/data/regionCatalog.ts      — Manifest loader, region discovery, download status
src/data/peakMerger.ts         — Merge Kirmse peaks with existing peak pipeline
```

### Loading Strategy

```
REGIONAL DATA CACHE (per-region, keyed by region ID)
├── Tier 1: In-memory (current session)
├── Tier 2: IndexedDB (ec-regions-v1)
└── Tier 3: /public/geo/regions/{id}.json (bundled or CDN-hosted)

NO Tier 4 (no live Overpass fallback) — intentionally omitted.
If regional data isn't available, Natural Earth is used. Clean degradation.
```

### Renderer Changes (MAP)

```
At z8+, if regional data is loaded for current viewport:
  → Use regional lakes/rivers/coastlines instead of Natural Earth
  → Regional features have full OSM detail (10-100x more vertices)
  → Natural Earth features in the same area are hidden to avoid doubling

At z1-z7 (or no regional data available):
  → Natural Earth as today, no change
```

### SCAN Integration

```
Current: fetchPeaksNear() → Overpass API → 24h IndexedDB cache → fallback hardcoded
New:     fetchPeaksNear() → regional bundle peaks (with prominence!) → existing fallback chain

Peak selection upgrade:
  Current: "nearest peaks by distance, max 8"
  New:     "most prominent peaks visible from viewpoint"
           → prominence ≥ 100m within 50km, ≥ 300m within 150km, ≥ 500m within 250km
           → shows the peaks that actually matter in the landscape
```

### Settings UI

New "Regions" section in Settings:
- Mini world map showing available regions as rectangles
- Each region shows: name, peak count, highest peak, file size, download status
- Tap to download / delete
- 3 bundled regions (Colorado, Alaska, Cascades) shown as "Included"
- Downloaded regions persist in IndexedDB

---

## Visual Verification System

Before shipping any region, you need to verify the data looks correct. Two approaches:

### 1. Pipeline Verification (during build)

The build script generates a verification HTML page per region:

```
scripts/build-regions/verify/{id}.html
```

Each page shows:
- Leaflet/MapLibre map centered on region bounds
- Peaks plotted as dots (color-coded by prominence: red >1000m, orange >300m, yellow >100m, gray <100m)
- Lakes as blue polygons
- Rivers as blue lines
- Coastlines as gray lines
- Stats overlay: peak count, lake count, river segments, total vertices, file size
- Side-by-side with Natural Earth data at the same location for comparison

Open in browser, visually inspect, approve. Quick sanity check before committing.

### 2. In-App Debug View

MAP screen debug panel (already exists for globe stats) gets a "Regional Data" section:
- Which regional bundles are loaded
- Feature counts visible at current zoom
- Toggle: show Natural Earth / show Regional / show both overlaid
- Highlight regional data boundaries on map

---

## Bundled vs Downloaded Regions

### Bundled (shipped with app, in `/public/geo/regions/`)
- Colorado Rockies (existing region)
- Alaska Range (existing region)
- Washington Cascades (in hardcoded peaks, logical to add as region)

These load instantly, no download prompt needed. ~5-15 MB total added to bundle.

### Downloaded (fetched on demand from CDN/S3)
- All other regions
- User explicitly requests download from Settings → Regions
- Cached permanently in IndexedDB
- Can be deleted to free space

### Hosting
- Same S3 bucket or CDN used for any future asset hosting
- Or: GitHub releases as a simple free host for static JSON
- Files are immutable — versioned by `version` field in manifest
- Manifest itself is tiny (<50 KB) and fetched on app load

---

## Peak Data Deep Dive: Kirmse Integration

### What the Kirmse Dataset Gives You

Each row: `lat, lng, elevation_m, prominence_m, isolation_km, line_parent_lat, line_parent_lng`

- **Prominence**: Height above the highest col connecting to a higher peak. The single most useful metric for "is this peak worth showing?" A 4000m peak with 50m prominence is just a bump on a ridge. A 3000m peak with 800m prominence dominates the skyline.
- **Isolation**: Distance to nearest higher peak. Useful for spacing labels.
- **Line parent**: The next higher peak in the prominence tree. Could enable "which range does this peak belong to?" queries.

### Prominence Thresholds for Display

| Context | Threshold | Rationale |
|---------|-----------|-----------|
| Regional bundle (stored) | ≥ 30m | Captures all named summits and significant terrain features |
| MAP peak dots (z8-9) | ≥ 300m | Only major peaks at continental zoom |
| MAP peak dots (z10-11) | ≥ 100m | Regional peaks visible |
| MAP peak labels (z12+) | ≥ 30m | All stored peaks |
| SCAN visible peaks | ≥ 100m within 50km | Prominence-weighted selection |
| SCAN visible peaks | ≥ 300m within 150km | Mid-range visibility |
| SCAN visible peaks | ≥ 500m within 250km | Only dominant skyline peaks |

### New Peak Type

```typescript
interface RegionalPeak {
  lat: number
  lng: number
  elevation_m: number
  prominence_m: number       // from Kirmse
  isolation_km?: number      // from Kirmse
  name?: string              // from OSM (undefined if unnamed)
  osmId?: number             // for attribution
}
```

This extends the existing `Peak` type (which has `name, lat, lng, elevation_m`) with prominence and isolation. The existing `Peak` type stays unchanged — `RegionalPeak` is a superset used only when regional data is available.

---

## Implementation Phases

### Phase 0: Validate (do this first, minimal effort)

**Goal**: Prove the data sources work and the approach is sound.

1. Download Kirmse CSV for one region (Colorado bounds: filter the full CSV)
2. Download OSM peaks for same region (single Overpass query, save as JSON)
3. Write a quick merge script — spatial join within 200m
4. Inspect the result: How many peaks? How many have names? Does prominence look right?
5. Compare Mount Elbert: Kirmse should show ~4399m elevation, ~2765m prominence
6. Download OSM water for Colorado bounds, save as GeoJSON
7. Compare lake detail: Natural Earth Dillon Reservoir vs OSM Dillon Reservoir vertex count

**If this looks good** → proceed to Phase 1. If the merge has issues or file sizes are unexpectedly large → adjust thresholds before building infrastructure.

### Phase 1: Build Pipeline + 3 Bundled Regions

1. Create `scripts/build-regions/` with:
   - `download-kirmse.ts` — Download and index the Kirmse CSV
   - `build-region.ts` — Generate a single region bundle from raw data
   - `build-manifest.ts` — Generate manifest.json from all built regions
   - `verify.ts` — Generate verification HTML pages
2. Build bundles for Colorado, Alaska, Washington Cascades
3. Visually verify all three
4. Create `src/data/regionalLoader.ts` — same 3-tier cache as geoLoader
5. Wire into MAP renderer: use regional data at z8+ when available
6. Wire into SCAN: use regional peaks (with prominence) instead of Overpass
7. No UI for downloading yet — just the 3 bundled regions

### Phase 2: Region Download UI + 15 More Regions

1. Build bundles for ~15 most popular regions (Alps, Himalayas, etc.)
2. Host on S3/CDN (or GitHub releases)
3. Add `regionCatalog.ts` — fetch manifest, track download status
4. Settings → Regions page with mini world map
5. Download/delete per region
6. Auto-detect GPS → suggest nearest region on first launch

### Phase 3: Full Catalog + Smart Prompting

1. Build out to ~40 regions
2. Banner when panning MAP past z9 into uncovered area
3. Show region size + peak count before download
4. "Download nearby" batch option
5. Consider TopoJSON if total hosted data is getting large

---

## What This Does NOT Include (Intentionally)

- **No live Overpass fallback** — if regional data isn't downloaded, Natural Earth is shown. Clean and predictable.
- **No user-drawn custom regions** — too complex for now. Pre-built regions cover the interesting terrain.
- **No automatic background downloads** — user explicitly chooses what to download.
- **No server-side processing** — everything is pre-built static files.

---

## File Size Estimates

| Region Type | Peaks | Water | Coast | Total |
|-------------|-------|-------|-------|-------|
| Dense mountains (Alps) | 500 KB | 3-5 MB | — | 3.5-5.5 MB |
| Coastal mountains (Cascades) | 300 KB | 2-3 MB | 1 MB | 3.3-4.3 MB |
| Remote peaks (Karakoram) | 200 KB | 0.5-1 MB | — | 0.7-1.2 MB |
| Volcanic islands (Hawaii) | 100 KB | 0.5 MB | 1.5 MB | 2.1 MB |

**Bundled 3 regions**: ~10-15 MB added to app bundle
**Full 40 regions hosted**: ~100-150 MB total on CDN (user downloads only what they need)

---

## Open Questions to Resolve

1. **Kirmse CSV size**: The full worldwide CSV is ~300 MB. Should the pipeline download the whole thing once, or can you pre-split it by continent? (Check the GitHub repo structure.)

2. **River detail level**: OSM has streams down to every tiny creek. For a terrain app, do you want `waterway=river` only (major rivers), or include `waterway=stream` (much more data, much larger files)? Recommendation: rivers only for Phase 1, streams as optional toggle later.

3. **Glacier data**: Natural Earth glaciers are decent at 1:10m. Worth including OSM glacier detail in regional bundles? Recommendation: skip for Phase 1, add if users request it.

4. **Prominence tree**: Kirmse includes "line parent" data — the prominence parent of each peak. This could power a "peak hierarchy" visualization (which peaks are sub-peaks of which). Worth storing? Recommendation: store it, it's a few extra bytes per peak and enables future features.

5. **Attribution**: OSM data requires attribution ("© OpenStreetMap contributors"). Kirmse dataset is CC0/public domain. Need an attribution line in the app for OSM-sourced features.
