# MAP Screen: Seamless Globe↔Flat Transition — Implementation Plan

## Goal
Make the globe and flat map perfectly aligned at every zoom level so they move together seamlessly, with unified interactions, consistent markers, and a polished zoom UX.

---

## Phase 1: Fix Pan Sync (Quick Win)

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** Line 1139-1140 — the flat→globe sync useEffect has a guard `if (zoom < GLOBE_GONE_ZOOM) return` which PREVENTS syncing during the transition zone (zoom 4-7). Globe drag syncs to centerLat/centerLng fine, but flat map drag never updates the globe.

**Fix:**
- Remove the `zoom < GLOBE_GONE_ZOOM` guard entirely
- The `globeDragRef.current.isDragging` guard (line 1138) already prevents feedback loops during globe drag
- Globe rotation should ALWAYS reflect centerLat/centerLng when the user isn't actively dragging the globe

**Also fix pointer event routing during transition:**
- Currently both canvases accept pointer events when `gOpacity > 0` — this creates an overlap where both canvases fight for input during zoom 4-7
- Change to: globe gets pointer events when `gOpacity > 0.5`, flat gets them when `gOpacity <= 0.5`
- This gives a clean handoff at the midpoint of the transition

---

## Phase 2: Scale-Matching Crossfade (Core Alignment Fix)

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** The globe's camera Z formula (`1.2 + 4.5 × 0.65^zoom`) was designed for aesthetics, not Mercator scale matching. At zoom 5, the globe shows 1.52× more area per pixel than the flat map. This causes features to appear at different sizes and positions during crossfade.

**Fix — render flat map at the globe's equivalent zoom during transition:**

1. Add a new helper function `globeEquivFlatZoom(camZ, viewHeight)`:
   ```
   equivZoom = log2(π × viewHeight / (tan(FOV/2) × TILE_SIZE × camZ))
   ```
   This computes what flat-map zoom level the globe's camera distance corresponds to.

2. In `drawMap()`, during the transition zone (globeOpacity > 0 AND < 1):
   - Compute `globeEquivFlatZoom` from current camera Z and canvas height
   - Use this as the effective zoom for flat map tile rendering instead of the raw display zoom
   - This means the flat map renders at a lower zoom (wider view) that matches the globe's visible area
   - As the user zooms past the transition zone (zoom > 7), the flat map switches to normal zoom

3. Update flat map pan sensitivity to use the effective zoom too, so drag speed matches between views.

**Expected result:** During crossfade, both views show the same geographic extent at the same scale. Features overlay pixel-perfectly at screen center, with minor divergence toward edges (unavoidable sphere-vs-flat distortion, invisible in practice).

**Note on tile resolution:** The flat map will render at ~z3.5-4.5 during transition, which is low-res. This matches the globe's z3 texture resolution, so they look equally detailed. No visual quality loss.

---

## Phase 3: Enhanced Debug Panel

**File:** `src/screens/MapScreen/MapScreen.tsx`

Redesign the debug panel to be an alignment validation tool:

**New sections to add:**
- **ALIGNMENT** section:
  - Globe equiv flat zoom (the computed value from Phase 2)
  - Effective flat zoom being used for rendering
  - Scale ratio at screen center (should be ~1.0 after Phase 2)
  - Active location projected to screen coords for BOTH views (pixel difference = alignment error)
- **POINTER ROUTING** section:
  - Which canvas currently owns pointer events
  - Last drag source (globe or flat)
- **TILE STATUS** section:
  - Tiles in-flight / cached / failed counts
  - Current tile zoom being used vs raw zoom

**Remove or condense:**
- Static scene info (atmosphere params, sphere segments) — move to a collapsed "Scene" subsection
- Formula explanations — useful during dev, noise during debugging

**Layout improvement:**
- Make the panel scrollable if content exceeds viewport
- Add a small "copy to clipboard" button for bug reports

---

## Phase 4: Zoom Slider Bar UX

**Files:** `MapScreen.tsx` + `MapScreen.module.css`

Replace the current thin range input with a proper visual zoom bar:

**Design:**
- Vertical bar on the right side, between + and − buttons (same position as now, but taller and more visible)
- Track: 6px wide, rounded, gradient from abyss (bottom/zoomed out) to glow (top/zoomed in)
- Thumb: 20px circle with glow, draggable
- Current zoom level shown as a small label next to the thumb (e.g., "Z9")
- Transition zone (zoom 4-7) marked with a subtle indicator on the track (slightly different color band or tick marks) so users understand where globe↔flat handoff happens
- Integer tick marks along the track (thin 4px horizontal lines)
- Total bar height: ~200px (up from current 120px) for more precise control

**Behavior:**
- Step stays at 0.1 for smooth fractional zooming
- +/- buttons still increment/decrement by 1 integer level
- Scroll wheel continues to work at ±0.5 steps

---

## Phase 5: Consistent Location Marker on Globe

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** Globe marker is a plain 0.02-radius teal sphere. Flat map marker has a beautiful 3-layer design (halo + ring + inner dot with glow).

**Fix — use a Three.js Sprite with a canvas-rendered texture:**
1. Create a small offscreen canvas (64×64px)
2. Draw the same 3-layer marker: outer halo (semi-transparent), ring (1.5px stroke), inner dot (solid with glow)
3. Use this canvas as a `SpriteMaterial` texture
4. Replace the current SphereGeometry marker with a `Sprite` positioned at the same lat/lng on the globe surface
5. Set `sprite.scale` to maintain consistent visual size as zoom changes (scale inversely with camera distance)
6. Use blue color when GPS mode, teal when exploring (matching flat map behavior)

---

## Phase 6: My Location Preserves Zoom

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** When tapping "My Location", the zoom may reset. The `handleMyLocation` function (line 1484-1526) only sets centerLat/centerLng and doesn't explicitly reset zoom — but verify there's no side effect causing it.

**Fix:**
- Confirm `handleMyLocation` does NOT call `setZoom` anywhere (it shouldn't)
- If the issue is the component remounting (navigating away and back resets `useState(DEFAULT_MAP_ZOOM)`), persist zoom to a ref or to the store so it survives navigation
- Add `zoom` to the location store or use a dedicated `mapStore` to persist map state across screen switches

---

## Phase 7: Tighten Transition Zone + Eased Opacity

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Current:** Linear blend from zoom 4 (globe 100%) to zoom 7 (flat 100%) — 3 zoom levels of ambiguity.

**New:**
- Narrow to zoom 5 → 6.5 (1.5 zoom levels — faster, more decisive)
- Use ease-in-out curve instead of linear: `opacity = 0.5 - 0.5 * cos(π * t)` where `t` is the normalized position in the transition range
- This means the crossfade starts slow, accelerates through the middle, and eases into the final state — feels more natural

**Update constants:**
- `GLOBE_FULL_ZOOM = 5` (was 4)
- `GLOBE_GONE_ZOOM = 6.5` (was 7)

---

## Phase 8: Tile Loading Optimization (Performance)

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** At high zoom (10+), tiles are small and numerous. Loading a screen of z10+ tiles is slow, especially offline from IndexedDB.

**Fix — progressive tile loading:**
1. When rendering at zoom N, first check if z(N-2) tiles are cached — if so, draw them scaled 4× as placeholder
2. Then load z(N) tiles in the background
3. As each z(N) tile arrives, redraw just that region at full resolution
4. This gives instant visual feedback at any zoom level

**Also:** During first visit, pre-cache z2-z4 tiles for the globe (16 tiles total — tiny) into IndexedDB so the globe always works offline. Currently `buildGlobeTexture` fetches them live.

---

## Order of Implementation

| Step | Phase | Estimated Effort | Impact |
|------|-------|-----------------|--------|
| 1 | Phase 1: Pan sync fix | Small (5-10 lines) | High — fixes the most visible bug |
| 2 | Phase 2: Scale matching | Medium (30-50 lines) | High — fixes core alignment |
| 3 | Phase 3: Debug panel | Medium (50-80 lines) | Medium — enables validation |
| 4 | Phase 7: Transition tuning | Small (10 lines) | Medium — feels smoother |
| 5 | Phase 4: Zoom slider bar | Medium (CSS + 20 lines JSX) | Medium — better UX |
| 6 | Phase 5: Globe marker | Medium (40 lines) | Low-medium — visual polish |
| 7 | Phase 6: Zoom persistence | Small (5-10 lines) | Low — edge case fix |
| 8 | Phase 8: Tile optimization | Medium-large (60-80 lines) | Medium — performance |

Total: ~8 focused changes, each independently testable. After phases 1-2, the core alignment should be resolved. Phase 3 gives us the tools to verify. Everything after is polish and performance.
