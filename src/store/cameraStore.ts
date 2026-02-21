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
  DEFAULT_ORBIT_RADIUS,
  DEFAULT_FOV,
  MIN_HEIGHT_M,
  MAX_HEIGHT_M,
  AUTO_ROTATE_DELAY_MS,
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

  // EXPLORE (orbit) camera
  orbitTheta: number     // Horizontal angle around center (radians)
  orbitPhi: number       // Vertical angle (radians, clamped 0.1 to π/2)
  orbitRadius: number    // Distance from center
  autoRotating: boolean  // Whether idle auto-rotation is active
  lastInteractionTime: number // Timestamp of last user touch/click

  // Actions
  /** Apply drag input to the SCAN camera — changes heading and pitch */
  applyARDrag: (deltaX: number, deltaY: number) => void
  /** Set the eye height for SCAN from the height slider (accepts feet for imperial display) */
  setHeightFromSlider: (heightFt: number) => void
  /** Set height directly in meters */
  setHeight_m: (height_m: number) => void
  /** Apply drag input to EXPLORE orbit camera */
  applyOrbitDrag: (deltaX: number, deltaY: number) => void
  /** Record that the user interacted with EXPLORE — stops auto-rotate */
  recordOrbitInteraction: () => void
  /** Check if auto-rotate should start and update state */
  tickAutoRotate: (deltaTime_s: number) => void
  /** Reset SCAN camera to defaults */
  resetARCamera: () => void
  /** Reset EXPLORE camera to defaults */
  resetOrbitCamera: () => void
  /** Get the current height in feet (for display) */
  getHeightFt: () => number
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useCameraStore = create<CameraStore>()((set, get) => ({
  // Initial SCAN camera state
  heading_deg: DEFAULT_HEADING,
  pitch_deg: DEFAULT_PITCH,
  height_m: DEFAULT_HEIGHT_M,
  fov: DEFAULT_FOV,

  // Initial EXPLORE camera state
  orbitTheta: degToRad(30),    // Start at a 30° angle so we see the terrain from a nice angle
  orbitPhi: degToRad(45),      // 45° down from vertical — good default view
  orbitRadius: DEFAULT_ORBIT_RADIUS,
  autoRotating: false,
  lastInteractionTime: Date.now(),

  /**
   * Handle drag input on the SCAN screen.
   * Left/right drag = heading change (looking around horizontally)
   * Up/down drag = pitch change (looking up/down)
   *
   * Sensitivity values are tuned for good feel — not too fast, not too slow.
   */
  applyARDrag: (deltaX, deltaY) => {
    const HEADING_SENSITIVITY = 0.3  // degrees per pixel
    const PITCH_SENSITIVITY = 0.2

    const { heading_deg, pitch_deg } = get()

    // normalizeAngle keeps heading in 0–360 range
    const newHeading = normalizeAngle(heading_deg + deltaX * HEADING_SENSITIVITY)
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

    set({
      orbitTheta: newTheta,
      orbitPhi: newPhi,
      autoRotating: false,
      lastInteractionTime: Date.now(),
    })
  },

  recordOrbitInteraction: () => {
    log.debug('Orbit interaction recorded — stopping auto-rotate')
    set({ autoRotating: false, lastInteractionTime: Date.now() })
  },

  /**
   * Called on each animation frame for the EXPLORE screen.
   * If the user hasn't interacted for AUTO_ROTATE_DELAY_MS, start rotating.
   */
  tickAutoRotate: (deltaTime_s) => {
    const { autoRotating, lastInteractionTime, orbitTheta } = get()
    const now = Date.now()
    const idleTime = now - lastInteractionTime

    if (!autoRotating && idleTime > AUTO_ROTATE_DELAY_MS) {
      // Just started auto-rotating
      log.debug('Auto-rotate started (idle for 3s)')
      set({ autoRotating: true })
    }

    if (autoRotating) {
      // Rotate slowly — 0.003 rad/s
      const rotationSpeed = 0.3  // degrees per second
      const deltaRad = (rotationSpeed * Math.PI / 180) * deltaTime_s
      set({ orbitTheta: orbitTheta + deltaRad })
    }
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
    log.info('Orbit camera reset to defaults')
    set({
      orbitTheta: degToRad(30),
      orbitPhi: degToRad(45),
      orbitRadius: DEFAULT_ORBIT_RADIUS,
      autoRotating: false,
      lastInteractionTime: Date.now(),
    })
  },

  getHeightFt: () => {
    return Math.round(metersToFeet(get().height_m))
  },
}))
