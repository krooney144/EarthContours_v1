# Plan: Mobile Map Zoom UX Improvements

## Problem Summary (with screenshot reference)
The MAP screen has several mobile UX issues visible in the screenshot:
1. **Pinch-to-zoom is jumpy** — pointer events (globe rotation) fire simultaneously with touch events (zoom), causing the globe to spin wildly when trying to zoom
2. **Zoom slider is a floating dot** — visible in screenshot as a tiny teal circle to the right of the +/- buttons with NO visible track line behind it. Completely unusable on phone.
3. **Atmosphere washes out the globe** — the teal-grey haze in the screenshot covers the entire globe surface, making terrain look faded and low-contrast
4. **Zoom 6 is too dark** — during globe→flat crossfade, the flat map (no brightness lift) blends with the brighter globe, creating a dark muddy appearance
5. **Control buttons positioning** — the +/- and control buttons sit inboard from the screen edge
6. **Debug panel too large** — shows ~30 lines of info, overwhelming on mobile

---

## Change 1: Fix Pinch-to-Zoom (Stop Globe Rotation During Pinch)

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Root cause:** `handleGlobePointerMove` (line ~1409) fires for each finger individually during a 2-finger pinch gesture. It applies rotation deltas via `earth.rotation.y += dx` and `earth.rotation.x += dy`. Meanwhile `handleGlobeTouchMove` (line ~1508) is trying to apply zoom. The rotation and zoom fight each other — the globe spins to the South Pole while the user is just trying to zoom.

**Fix:**
- Add a `touchCountRef = useRef(0)` that tracks active touch count on the globe canvas
- In `handleGlobeTouchStart`: set `touchCountRef.current = e.touches.length`
- In `handleGlobeTouchEnd`: set `touchCountRef.current = e.touches?.length || 0`
- In `handleGlobePointerDown`: if `touchCountRef.current >= 2`, don't start drag state
- In `handleGlobePointerMove`: early-return if `touchCountRef.current >= 2` — completely suppress rotation during any multi-touch gesture
- When pinch begins, kill momentum: set `velocityX = velocityY = 0`

**Finger-anchored zoom (Apple Maps style):**
- On `handleGlobeTouchStart` with 2 fingers: record the midpoint between fingers in client coords (`pinchCenterX/Y`)
- Raycast from that midpoint to get the lat/lng on the globe under the pinch center
- Store as `globePinchRef.current.anchorLat/anchorLng`
- On `handleGlobeTouchMove`: compute new zoom from pinch scale ratio, then adjust globe rotation so the anchor lat/lng stays projected to the same screen position
- This keeps the terrain between your fingers visually pinned while zooming — same behavior as Apple/Google Maps

---

## Change 2: Improve Zoom Slider for Mobile

**Files:** `src/screens/MapScreen/MapScreen.module.css` + `MapScreen.tsx`

**Problem (visible in screenshot):** The slider uses `writing-mode: vertical-lr` with `width: 120px` (becomes height) and `height: 4px` (becomes track width). The `::-webkit-slider-runnable-track` styles don't render on many mobile browsers with vertical writing mode, leaving just the 16px thumb dot floating with no track.

**Fix — CSS improvements:**
- Increase track width from 4px to 6px
- Increase thumb from 16×16 to 24×24px with padding for 44px touch target
- Add a `background` gradient directly on `.zoomSlider` as a fallback for browsers that ignore `::-webkit-slider-runnable-track` in vertical mode
- Add a subtle 1px border on the track for visibility against dark backgrounds
- Increase slider length from 120px to 160px for more precision

**Fix — JSX improvements:**
- Add small "+" label above and "−" label below the slider (or zoom numbers) for orientation
- Show current zoom level as a small floating badge near the thumb position

---

## Change 3: Atmosphere → Subtle Edge-Only Halo

**File:** `src/screens/MapScreen/MapScreen.tsx` — `createAtmosphereSprite()` (line ~460)

**Problem (visible in screenshot):** The radial gradient starts at `r * 0.28` (28% of texture radius = well inside the globe disk) with opacity 0.30, and uses `AdditiveBlending`. The 3.2× scale sprite covers the entire globe and beyond. The screenshot shows the teal-grey wash across all terrain, killing contrast.

**Fix — edge-only halo ring:**
- Reshape the radial gradient so it's fully transparent over the globe's disk area and only glows outside the limb:
  - `0 → 0.44`: `rgba(0,0,0,0)` — fully transparent (this covers the globe surface)
  - `0.44 → 0.48`: ramp up to `rgba(132, 209, 219, 0.15)` — the visible rim
  - `0.48 → 0.58`: `rgba(75, 142, 163, 0.10)` — outer glow
  - `0.58 → 1.0`: fade to transparent
- Keep `AdditiveBlending` and `renderOrder: -1`
- Keep `scale.set(3.2, 3.2, 1)` — same size, just the gradient shape changes
- Result: a thin teal rim light at the edge of the globe (like Earth's atmosphere seen from space), with zero fog on the surface

---

## Change 4: Fix Zoom 6 Darkness

**File:** `src/screens/MapScreen/MapScreen.tsx`

**Problem:** The globe texture has a brightness lift applied during `buildGlobeTexture()` (line ~416: `R×1.5+18, G×1.4+22, B×1.3+28`). The flat DEM map has no such lift. During the crossfade (zoom 5–6.5), the brighter globe blends with the darker flat map, creating a muddy dark appearance at zoom 6.

**Fix — CSS brightness filter during transition:**
- In the JSX where the flat map canvas `style` is set (line ~1785), add a dynamic `filter` property:
  ```
  filter: gOpacity > 0 ? `brightness(${1 + gOpacity * 0.35})` : 'none'
  ```
- At zoom 5 (gOpacity=1): flat map gets `brightness(1.35)` — matches the globe's lift
- At zoom 6 (gOpacity≈0.33): flat map gets `brightness(1.12)` — gentle boost
- At zoom 6.5+ (gOpacity=0): flat map is normal `brightness(1)` — no change
- This is GPU-accelerated via CSS compositing, no pixel processing needed

---

## Change 5: Reposition Control Buttons for Mobile Edge

**File:** `src/screens/MapScreen/MapScreen.module.css`

**Fix:**
- Change `.controls` from `right: var(--space-3)` to `right: var(--space-2)` (closer to edge)
- Add mobile media query `@media (max-width: 480px)`:
  - `right: 8px` — snug to screen edge
  - `bottom: calc(var(--ec-nav-height) + 16px)` — slightly less space above nav
  - Slightly increase `gap` to `var(--space-3)` to prevent accidental adjacent button presses

---

## Change 6: Trim Debug Panel to Essential Info

**File:** `src/screens/MapScreen/MapScreen.tsx` (line ~2040–2097)

**Currently shows (~30 lines):** Mode, Zoom+TileZ, Globe/Flat alpha, Transition explanation, Camera Z, Pointer target, Alignment (flat center, deg/px globe & flat, ratio, arc), Texture (tex zoom, UV, material, tiles, ready), Scene (atmos, frames, segments), Globe Source (center, raw rotation, formula), Active Location (dot, GPS), Sync (delta), Flat Map (draw time, skip, debounce), Lakes (toggle, count, types, vertices, top 3)

**Trim to (~8 lines):**
- **Line 1:** `Mode: GLOBE | Zoom: 3.20 | Tile Z: 3`
- **Line 2:** `Globe α: 1.00 · Flat α: 0.00`
- **Line 3:** `Center: 39.8597°, -105.2230°`
- **Line 4:** `── Lakes ──`
- **Line 5:** `Toggle: ON · Count: 47`
- **Line 6:** `Types: lake:32 reservoir:15`
- **Line 7:** `── Rivers ──`
- **Line 8:** River count / status if available

**Remove everything else:** Camera Z, Pointer routing, Alignment section, Texture section, Scene section, Globe Source section, Active Location, Sync deltas, Flat Map stats, formula notes. These are dev-only diagnostics that aren't needed for regular use.

---

## Files Modified
1. `src/screens/MapScreen/MapScreen.tsx` — Changes 1, 2 (minor), 3, 4, 6
2. `src/screens/MapScreen/MapScreen.module.css` — Changes 2, 5

## Order of Implementation

| Step | Change | Impact |
|------|--------|--------|
| 1 | Fix pinch-to-zoom (Change 1) | **Critical** — biggest pain point |
| 2 | Atmosphere edge halo (Change 3) | **High** — immediate visual improvement |
| 3 | Zoom slider visibility (Change 2) | **High** — currently unusable |
| 4 | Zoom 6 brightness (Change 4) | **Medium** — transition polish |
| 5 | Button positioning (Change 5) | **Medium** — ergonomics |
| 6 | Debug panel trim (Change 6) | **Medium** — cleanup |

## Testing
- `npm run dev` → test on phone or Chrome DevTools mobile emulation
- Verify: pinch-to-zoom doesn't rotate the globe
- Verify: zoom slider track is visible and thumb is grabbable on mobile
- Verify: globe surface has full-contrast terrain with thin edge glow only
- Verify: zoom 5→7 transition doesn't go dark
- Verify: debug panel is compact (~8 lines)
- `npm run type-check` and `npm run build` for no regressions
