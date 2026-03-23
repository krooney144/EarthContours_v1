# SCAN Screen Architecture Decisions

Reference document for future development sessions. Captures the architectural discussion and decisions made for the SCAN rendering pipeline.

---

## Current Architecture

- **Worker ray march**: The skyline worker (`skylineWorker.ts`) ray-marches across DEM tiles and produces 6 depth bands (ultra-near through far) with per-azimuth elevation angles, distances, and GPS coordinates. Each band has its own tile zoom level (z15 down to z8) and contour interval (50ft up to 2000ft).
- **Painter's-order rendering**: The main thread renders bands far-to-near with depth cues — line weight (1-5px), opacity (0.15-0.9), and progressive fill darkness.
- **AGL re-projection on main thread**: `reprojectBands()` re-derives elevation angles from raw band data when viewer height changes. ~15,840 atan2 calls, sub-millisecond. No worker round-trip for AGL slider changes.
- **Two-pass peak refinement**: After the initial skyline completes, the main thread identifies visible peaks and sends a `'refine-peaks'` message to the worker. The worker fetches higher-zoom tiles (`distToRefinedZoom()`, +1-2 zoom levels above standard) around each peak and does a dense 0.05-degree ray march with 1.005x distance steps for genuinely more terrain detail.
- **RAF-gated canvas rendering**: Canvas redraws are gated through `requestAnimationFrame`. Typical frame cost is 8-20ms on phones.

---

## Key Performance Finding

The AGL slider jank is **not** from re-projection (sub-ms). It comes from two sources:

1. **Canvas rendering**: 8-20ms per frame to redraw ridgelines, contours, and fills.
2. **No slider debouncing**: Every pointer-move event triggers a full re-render.
3. **`buildContourStrands()` re-runs unnecessarily**: Contour strand computation (3-10ms) re-runs on every AGL change even though contour geometry does not depend on AGL.

Total frame cost during AGL drag: 15-30ms, exceeding the 16ms budget on phones.

---

## Decision: Silhouette Trace Replacing Bands

### Why

Instead of 6 discrete depth bands with one max elevation angle per azimuth per band, store the "winning steps" — every ray march step that pushed the silhouette envelope upward. Typically 3-8 steps per azimuth vs 500 total steps marched.

### Benefits

- **Features render at true distance**: Lakes, rivers, and coastlines render at their actual distance with no band assignment needed.
- **Continuous painter's order**: No awkward band boundaries for features that span multiple distance ranges.
- **Continuous depth cue interpolation**: Opacity and line weight interpolate smoothly across distance instead of jumping between 6 discrete levels.
- **Partial occlusion clipping**: The full silhouette envelope makes it possible to clip features that are partially hidden behind closer terrain.
- **Lower memory**: ~720 azimuths x ~8 winning steps x 16 bytes = ~92KB, compared to ~1MB for the current band arrays.

### Near-field detail concern

Under ~100-150km is where visual detail matters most. The current system uses higher resolution (2880 azimuths) for the three near bands (0-31km) and z15/z14/z13 tile zoom. The silhouette trace preserves this naturally — winning steps in the near range are denser because terrain changes more rapidly up close. Far terrain (150-400km) might only produce 1-2 winning steps per azimuth, which is fine since the angular change from AGL adjustments is imperceptible at those distances.

### AGL re-projection with trace

Re-project each winning step's elevation angle, then re-evaluate the envelope (a step that was "winning" at AGL=0 might not be at AGL=500m). Linear scan per azimuth: ~720 x 8 = ~5,760 comparisons. Negligible.

For small AGL changes during slider drag, use a Taylor approximation instead of atan2:

```
angle_new ~ angle_old - deltaHeight / (dist^2 + dElev^2) * dist
```

Only snap to true atan2 on drag release.

---

## Decision: Don't Split Workers (Yet)

Explored SharedArrayBuffer for a shared tile cache across multiple workers. Decision: **not worth the complexity now**.

### Reasons against

- Splitting workers does not reduce total computation, just spreads it across threads.
- The main thread canvas rendering is the bottleneck, not worker computation.
- SharedArrayBuffer requires COOP/COEP headers, complicating deployment.
- Worker coordination (Atomics, MessageChannels) adds fragile complexity.

### When to revisit

When the "downloaded areas" offline feature ships. At that point, a tile service abstraction (possibly a ServiceWorker) makes sense as the single source of truth for "do I have this tile?" But that is data management, not rendering performance.

---

## Decision: Features (Lakes/Rivers) as Phase 7 in Skyline Worker

### Why in the same worker

The skyline worker already has elevation tiles cached in `tileCacheW` after the ray march. Feature projection needs the same tiles to look up ground elevation at each polygon vertex. A separate worker would duplicate tile fetching.

### How it works

1. Main thread sends lake/river/coast polygon coords (from `waterLoader.ts` OSM fetch) to the worker alongside or after the skyline request.
2. Worker Phase 7: For each feature vertex, look up elevation from cached tiles, compute bearing + distance + elevation angle from the viewer.
3. Return projected feature geometry to the main thread.
4. Renderer interleaves features at their true distance in the painter's order.

### Interaction with silhouette trace

Features at a given distance get drawn between the winning steps that bracket that distance. A lake at 15km draws after the ~22km winning step and before the ~1.2km winning step. Automatically occluded by closer terrain — no explicit occlusion check needed.

### AGL and features

Valley features (rivers, lakes at low elevation) may be invisible at low AGL (hidden behind closer ridges) but become visible at higher AGL. Store raw `{groundElev, dist, bearing}` per vertex, re-project on AGL change (trivial cost for ~50-vertex polygons).

---

## Decision: AGL Slider Throttle + Drag Mode

Fix the immediate jank by:

1. **RAF-gate the slider itself**: At most one state update per frame, not one per pointer event.
2. **During drag**: Skip contour strand rendering, render ridgelines only (1 pass instead of 12).
3. **On drag release**: Full re-render with contours.

Expected improvement: 20-30ms/frame down to 3-5ms/frame during drag.

---

## Research References

Key algorithms and prior art informing these decisions:

- **Voxel Space / Comanche (1992)**: Column-based Y-buffer terrain rendering, front-to-back with occlusion buffer.
- **Stewart's Fast Horizon Computation (1998)**: Efficient terrain horizon/skyline computation.
- **HORAYZON (Steger, 2022)**: Modern horizon computation using ray tracing, 100x speedup.
- **Apparent Ridges (Judd et al., 2007)**: View-dependent curvature for stroke width modulation.
- **PeakFinder app**: Closest existing product — azimuthal ray-march across DEM, vector ridgeline art.
- **Swiss Topo panorama maps**: Lake/river features projected onto panoramic terrain views.
- **Geometry clipmaps**: Concentric LOD rings for continuous distance-based detail (analogous to winning-step density).

---

## Priority Order

1. **AGL slider throttle** — Immediate UX fix.
2. **Lakes/rivers as Phase 7** — New visual feature.
3. **Silhouette trace replacing bands** — Architectural improvement enabling better features + continuous depth.
4. **Tile service abstraction** — Prep for offline/downloaded areas (future).
5. **Separate tile worker/ServiceWorker** — Only when offline ships (future).
