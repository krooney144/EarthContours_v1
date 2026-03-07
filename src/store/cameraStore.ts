/**
 * EarthContours — Camera Store
 *
 * Controls the viewpoint for both the SCAN (first-person AR) and EXPLORE (orbit) screens.
 * These are kept in one store because they share some state (like field of view)
 * and may eventually sync (e.g., orbit camera could follow SCAN heading).
 *
 * SCAN camera: Think of a person standing on a hill, looking around.
 *   - heading_deg: which direction they face (N/S/E/W)
 *   - pitch_deg: how far up/down they tilt their head
 *   - height_m: how high above the ground they're standing
 *
 * EXPLORE camera: Think of a drone orbiting a terrain model.
 *   - theta: horizontal rotation around the center
 *   - phi: vertical angle (0=top, π/2=side)
 *   - radius: distance from the center
 */

import { create } from 'zustand'
import { createLogger } from '../core/logger'
import {
  DEFAULT_HEADING,
  DEFAULT_PITCH,
  DEFAULT_HEIGHT_M,
  DEFAULT_FOV,
  MIN_HEIGHT_M,
  MAX_HEIGHT_M,
  ORBIT_RADIUS_MIN_M,
  ORBIT_RADIUS_MAX_M,
  ORBIT_RADIUS_FALLBACK_M,
} from '../core/constants'
import { clamp, feetToMeters, metersToFeet, degToRad, normalizeAngle } from '../core/utils'

const log = createLogger('STORE:CAMERA')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface CameraStore {
  // SCAN (AR first-person) camera
  heading_deg: number    // 0–360, compass direction facing
  pitch_deg: number      // -90 to 90, tilt (negative=down, positive=up)
  height_m: number       // Eye height above ground in meters
  fov: number            // Field of view in degrees

  // EXPLORE (orbit) camera — all distances in metres
  orbitTheta: number          // Horizontal angle around pivot (radians)
  orbitPhi: number            // Vertical angle from top (radians, clamped 0.1 – π/2)
  orbitRadius: number         // Camera distance from pivot in METRES (lower = closer)
  orbitDefaultRadius: number  // Auto-computed from terrain width; reference for pan sensitivity
  orbitPanX: number           // Pivot X offset as fraction of terrain width [-0.5, 0.5]
  orbitPanZ: number           // Pivot Z offset as fraction of terrain depth [-0.5, 0.5]

  // Actions
  /** Apply drag input to the SCAN camera — changes heading and pitch */
  applyARDrag: (deltaX: number, deltaY: number) => void
  /** Set the eye height for SCAN from the height slider (accepts feet for imperial display) */
  setHeightFromSlider: (heightFt: number) => void
  /** Set height directly in meters */
  setHeight_m: (height_m: number) => void
  /** Apply drag input to EXPLORE orbit camera — changes theta and phi (rotate/tilt) */
  applyOrbitDrag: (deltaX: number, deltaY: number) => void
  /** Pan the orbit camera across the terrain — moves the look-at pivot point */
  applyOrbitPan: (deltaX: number, deltaY: number) => void
  /** Zoom the orbit camera in or out by adjusting orbitRadius (metres) */
  applyOrbitZoom: (delta: number) => void
  /** Directly set the normalised pan offset (used for fly-to double-click) */
  setOrbitPan: (panX: number, panZ: number) => void
  /**
   * Initialise the orbit camera for a newly-loaded terrain.
   * Sets orbitRadius and orbitDefaultRadius from the terrain's physical width
   * so the full terrain is visible at the default zoom level.
   * Call this whenever a new terrain mesh loads.
   */
  initOrbitCamera: (terrainWidth_m: number) => void
  /** Reset SCAN camera to defaults */
  resetARCamera: () => void
  /** Reset EXPLORE camera to defaults */
  resetOrbitCamera: () => void
  /** Get the current height in feet (for display) */
  getHeightFt: () => number
  /** Set SCAN field-of-view directly (clamped 15°–100°) — used by pinch zoom */
  setFov: (fov: number) => void
  /** Apply a relative FOV scale factor (> 1 = wider, < 1 = narrower) */
  applyFovScale: (scale: number) => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useCameraStore = create<CameraStore>()((set, get) => ({
  // Initial SCAN camera state
  heading_deg: DEFAULT_HEADING,
  pitch_deg: DEFAULT_PITCH,
  height_m: DEFAULT_HEIGHT_M,
  fov: DEFAULT_FOV,

  // Initial EXPLORE camera state — orbitRadius/orbitDefaultRadius updated by
  // initOrbitCamera() once the first terrain mesh loads.
  orbitTheta: degToRad(30),
  orbitPhi: degToRad(45),
  orbitRadius: ORBIT_RADIUS_FALLBACK_M,
  orbitDefaultRadius: ORBIT_RADIUS_FALLBACK_M,
  orbitPanX: 0,
  orbitPanZ: 0,

  /**
   * Handle drag input on the SCAN screen.
   * Left/right drag = heading change (looking around horizontally)
   * Up/down drag = pitch change (looking up/down)
   *
   * Sensitivity scales proportionally with FOV so that zoomed-in views
   * feel natural — a finger drag moves the same *visual* distance on screen
   * regardless of zoom level. At default FOV (70°), sensitivity matches
   * the original fixed values. At FOV 20°, sensitivity drops to ~29%.
   *
   * Formula: baseSensitivity × (currentFOV / defaultFOV)
   * TODO: If gyroscope mode is active, this function is bypassed entirely.
   */
  applyARDrag: (deltaX, deltaY) => {
    const BASE_HEADING_SENSITIVITY = 0.3  // degrees per pixel at default FOV
    const BASE_PITCH_SENSITIVITY = 0.2

    const { heading_deg, pitch_deg, fov } = get()

    // Scale sensitivity proportionally with FOV so zoomed-in views aren't too jumpy
    const fovScale = fov / DEFAULT_FOV
    const HEADING_SENSITIVITY = BASE_HEADING_SENSITIVITY * fovScale
    const PITCH_SENSITIVITY = BASE_PITCH_SENSITIVITY * fovScale

    // normalizeAngle keeps heading in 0–360 range
    // Negate deltaX: drag right → view pans right → heading decreases (like scrolling a panoramic photo)
    const newHeading = normalizeAngle(heading_deg - deltaX * HEADING_SENSITIVITY)
    // Clamp pitch so you can't flip upside down (-80° to 80°)
    const newPitch = clamp(pitch_deg - deltaY * PITCH_SENSITIVITY, -80, 80)

    log.debug('AR drag applied', {
      deltaX: deltaX.toFixed(1),
      deltaY: deltaY.toFixed(1),
      newHeading: newHeading.toFixed(1),
      newPitch: newPitch.toFixed(1),
    })

    set({ heading_deg: newHeading, pitch_deg: newPitch })
  },

  /**
   * Set height from the vertical slider on SCAN screen.
   * The slider shows feet (imperial) but we store meters internally.
   */
  setHeightFromSlider: (heightFt) => {
    const height_m = clamp(feetToMeters(heightFt), MIN_HEIGHT_M, MAX_HEIGHT_M)
    log.debug('Height set from slider', { heightFt: heightFt.toFixed(0), height_m: height_m.toFixed(1) })
    set({ height_m })
  },

  setHeight_m: (height_m) => {
    const clamped = clamp(height_m, MIN_HEIGHT_M, MAX_HEIGHT_M)
    log.debug('Height set directly', { height_m: clamped.toFixed(1) })
    set({ height_m: clamped })
  },

  /**
   * Handle drag input on the EXPLORE orbit camera.
   * Dragging left/right rotates the orbit (theta).
   * Dragging up/down changes the viewing angle (phi).
   * Used for right-click drag on desktop, 2-finger rotate+tilt on mobile.
   */
  applyOrbitDrag: (deltaX, deltaY) => {
    const THETA_SENSITIVITY = 0.008   // radians per pixel
    const PHI_SENSITIVITY = 0.006

    const { orbitTheta, orbitPhi } = get()

    const newTheta = orbitTheta + deltaX * THETA_SENSITIVITY
    // Clamp phi: 0.1 radians = almost top-down, 1.45 radians = almost side-on
    const newPhi = clamp(orbitPhi + deltaY * PHI_SENSITIVITY, 0.1, 1.45)

    log.debug('Orbit drag applied', {
      deltaX: deltaX.toFixed(1),
      deltaY: deltaY.toFixed(1),
      newTheta: newTheta.toFixed(3),
      newPhi: newPhi.toFixed(3),
    })

    set({ orbitTheta: newTheta, orbitPhi: newPhi })
  },

  /**
   * Pan the EXPLORE camera across the terrain.
   * Used for left-click drag on desktop, 1-finger drag on mobile.
   *
   * Converts screen-space drag (CSS pixels) to world-space pan offset.
   * Pan sensitivity scales with zoom level so the terrain feels the same
   * to interact with regardless of how far in/out you've zoomed.
   *
   * The math: screen drag is decomposed into camera-local X (strafe) and
   * Z (depth) movements, then rotated back to world space by theta to keep
   * the terrain sliding under the cursor at the correct angle.
   */
  applyOrbitPan: (deltaX, deltaY) => {
    const { orbitTheta, orbitPhi, orbitRadius, orbitDefaultRadius, orbitPanX, orbitPanZ } = get()

    // Pan sensitivity: scales with zoom so the terrain feels consistent at any distance.
    // orbitDefaultRadius is the "full terrain in view" reference distance.
    const PAN_SENSITIVITY = 0.0025 * (orbitRadius / orbitDefaultRadius)
    // Vertical drag pans in depth — adjust for viewing angle (more top-down = more depth per pixel)
    const vertSens = PAN_SENSITIVITY / Math.max(0.25, Math.sin(orbitPhi))

    const cos_t = Math.cos(orbitTheta)
    const sin_t = Math.sin(orbitTheta)

    // Decompose screen drag into world-space pan (undo theta rotation)
    const dGx = -deltaX * PAN_SENSITIVITY * cos_t + deltaY * vertSens * sin_t
    const dGz = -deltaX * PAN_SENSITIVITY * sin_t - deltaY * vertSens * cos_t

    log.debug('Orbit pan applied', {
      deltaX: deltaX.toFixed(1),
      deltaY: deltaY.toFixed(1),
      dGx: dGx.toFixed(4),
      dGz: dGz.toFixed(4),
    })

    set({ orbitPanX: orbitPanX + dGx, orbitPanZ: orbitPanZ + dGz })
  },

  /**
   * Zoom the orbit camera in or out.
   * delta > 0 = zoom out (increase radius), delta < 0 = zoom in (decrease radius).
   * Used for scroll wheel, pinch gesture.
   */
  applyOrbitZoom: (delta) => {
    const { orbitRadius } = get()
    // Multiply radius by a factor — exponential feel regardless of scale
    const newRadius = clamp(orbitRadius * (1 + delta * 0.15), ORBIT_RADIUS_MIN_M, ORBIT_RADIUS_MAX_M)
    log.debug('Orbit zoom applied', {
      delta: delta.toFixed(3),
      oldRadius: orbitRadius.toFixed(2),
      newRadius: newRadius.toFixed(2),
    })
    set({ orbitRadius: newRadius })
  },

  /**
   * Directly set pan position — used by double-click fly-to.
   * Moves the look-at point to the specified world coordinates.
   */
  setOrbitPan: (panX, panZ) => {
    log.debug('Orbit pan set', { panX: panX.toFixed(4), panZ: panZ.toFixed(4) })
    set({ orbitPanX: panX, orbitPanZ: panZ })
  },

  initOrbitCamera: (terrainWidth_m) => {
    // Place the camera at 80 % of terrain width — shows full terrain with a little margin
    const defaultRadius = clamp(terrainWidth_m * 0.8, ORBIT_RADIUS_MIN_M, ORBIT_RADIUS_MAX_M)
    log.info('Orbit camera initialised for terrain', {
      terrainWidth_m: terrainWidth_m.toFixed(0),
      orbitRadius_m: defaultRadius.toFixed(0),
    })
    set({
      orbitRadius: defaultRadius,
      orbitDefaultRadius: defaultRadius,
      orbitPanX: 0,
      orbitPanZ: 0,
      orbitTheta: degToRad(30),
      orbitPhi: degToRad(45),
    })
  },

  resetARCamera: () => {
    log.info('AR camera reset to defaults')
    set({
      heading_deg: DEFAULT_HEADING,
      pitch_deg: DEFAULT_PITCH,
      height_m: DEFAULT_HEIGHT_M,
      fov: DEFAULT_FOV,
    })
  },

  resetOrbitCamera: () => {
    const { orbitDefaultRadius } = get()
    log.info('Orbit camera reset to defaults')
    set({
      orbitTheta: degToRad(30),
      orbitPhi: degToRad(45),
      orbitRadius: orbitDefaultRadius,
      orbitPanX: 0,
      orbitPanZ: 0,
    })
  },

  getHeightFt: () => {
    return Math.round(metersToFeet(get().height_m))
  },

  setFov: (fov) => {
    const clamped = clamp(fov, 15, 100)
    log.debug('FOV set', { fov: clamped.toFixed(1) })
    set({ fov: clamped })
  },

  applyFovScale: (scale) => {
    const { fov } = get()
    const newFov = clamp(fov * scale, 15, 100)
    log.debug('FOV scaled', { scale: scale.toFixed(3), oldFov: fov.toFixed(1), newFov: newFov.toFixed(1) })
    set({ fov: newFov })
  },
}))
