# Plan: Fix Atmosphere, Zoom Transition, and Slider

## Problem 1: Atmosphere halo renders IN FRONT of the Earth

**Root cause:** The atmosphere is a `THREE.Sprite` (flat billboard quad) with `depthTest: false` and additive blending. Sprites are always camera-facing 2D planes — they cannot wrap around a 3D sphere. Even with `renderOrder = -1` (draws first), additive blending adds its glow on top of the dark background, then the Earth draws over the center. But the semi-transparent gradient edges still show through, because the sprite's glow extends across the entire globe disk area before the Earth can occlude it. A sprite fundamentally cannot produce a "behind the sphere" atmosphere.

**Fix — Replace sprite with a Fresnel BackSide shader on a larger sphere:**
- Create a `THREE.SphereGeometry(1.03, 64, 64)` — slightly larger than the Earth (r=1.0)
- Apply a `THREE.ShaderMaterial` with `side: THREE.BackSide`:
  - BackSide means only the inner face of the sphere renders
  - The Earth (r=1.0) naturally occludes the front-facing region via depth buffer
  - Only the limb (edge) of the atmosphere sphere peeks past the Earth → edge-only glow
- Vertex shader: pass `vNormal` and view direction to fragment
- Fragment shader: Fresnel term `pow(1.0 - abs(dot(viewDir, normal)), 3.0)`
  - At face-on angles: dot ≈ 1, Fresnel ≈ 0 → transparent
  - At grazing angles (edge): dot ≈ 0, Fresnel ≈ 1 → bright glow
- Color: `vec3(0.35, 0.75, 0.85)` (teal, matching ec-glow palette)
- `transparent: true`, `depthWrite: false`, additive blending
- Delete the `createAtmosphereSprite()` function entirely
- Update `threeRef` type: `atmosphere: THREE.Sprite` → `atmosphere: THREE.Mesh`
- Update scene init to use `createAtmosphereMesh()` instead

## Problem 2: Zoom 5→7 crossfade is jarring

**Root cause:** The transition window is only 1.5 zoom levels (GLOBE_FULL_ZOOM=5 → GLOBE_GONE_ZOOM=6.5). This creates three issues:
1. The scale difference between globe at z5 and flat map at z7 is huge — the visual "jump" is sudden
2. During the 1.5-level blend, both layers are semi-transparent — globe (low-res z2/z3 texture) and flat (sharp z7 tiles) look completely different, creating a muddy double-exposure
3. A couple of pinch ticks or scroll events can skip the entire transition

**Fix — Widen transition range + ease the camera curve:**
- Change `GLOBE_FULL_ZOOM = 4` (was 5) and `GLOBE_GONE_ZOOM = 8` (was 6.5)
- This gives **4 zoom levels** of gradual transition instead of 1.5
- The cosine ease-in-out is already good — wider range means it's naturally smoother
- Adjust `zoomToCameraZ()` so the camera Z at zoom 8 still produces reasonable globe scale
- The brightness filter on the flat map (already applied) will continue to smooth the brightness match
- Consider: at the wide transition midpoint (zoom 6), globe α ≈ 0.5 — the longer blend gives the eye more time to adjust

## Problem 3: Zoom slider doesn't match reference (Google Maps style)

**Reference image analysis:** The Google Maps-style control shows:
```
  [◎]  ← location button (separate, above zoom controls)
  [+]  ← zoom in button
   |
   ●   ← vertical slider track with round thumb
   |
  [−]  ← zoom out button
```

**Current problems:**
- Uses CSS `writing-mode: vertical-lr` hack that renders as horizontal on many mobile browsers (visible in screenshot — the track extends to the right, not downward)
- Track is thin (6px) and hard to see
- No visible relationship between +/− buttons and slider

**Fix — Custom div-based vertical slider (no `<input type="range">`):**
- Replace `<input type="range">` with a custom component:
  - `.zoomTrackContainer` — 32px wide touch target, 120px tall, centered between +/−
  - `.zoomTrack` — 4px wide, full height, centered, rounded, subtle border color
  - `.zoomThumb` — 18px circle, white with glow, positioned via CSS `top` percentage
  - Thumb position: `top = (1 - (zoom - min) / (max - min)) * 100%` (top = zoomed in, bottom = zoomed out)
- Pointer events:
  - `onPointerDown` on container: start drag, calculate zoom from clientY
  - `onPointerMove` while dragging: map clientY to zoom value
  - `onPointerUp`: end drag
  - Tap anywhere on track: jump thumb to that position
- Layout order in `.controls` div:
  1. Location button (◎)
  2. Area select button (⬜)
  3. `+` button
  4. Custom vertical slider
  5. `−` button

**CSS:**
- Track: `background: rgba(255, 255, 255, 0.15)`, 4px wide, rounded
- Thumb: `background: white`, `border: 2px solid var(--ec-glow)`, `box-shadow: glow`
- No labels needed — +/− buttons above and below are self-explanatory
- Delete all the old `.zoomSlider`, `::-webkit-slider-*`, `::-moz-range-*` CSS rules

## Files Modified
1. `src/screens/MapScreen/MapScreen.tsx` — All 3 changes
2. `src/screens/MapScreen/MapScreen.module.css` — Slider CSS

## Order of Implementation
1. Atmosphere → Fresnel BackSide mesh (biggest visual impact)
2. Custom vertical slider (most visible UX fix)
3. Widen zoom transition (smoothness)
