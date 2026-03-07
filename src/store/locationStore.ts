/**
 * EarthContours — Location Store
 *
 * Manages two location concepts:
 * 1. GPS position: the device's real physical location
 * 2. Active/explore position: where the terrain is centered
 *
 * These are separate because the MAP screen lets users click anywhere
 * to "explore" that location, even if they're physically miles away.
 * When in "exploring" mode, the terrain shows the explored location,
 * not the GPS location.
 *
 * "My Location" button in MAP screen switches back to GPS mode.
 */

import { create } from 'zustand'
import type { LocationMode, GPSPermission, SensorData, LatLng } from '../core/types'
import { createLogger } from '../core/logger'
import { GPSError, LocationPermissionError, isPermissionDenied } from '../core/errors'
import { DEFAULT_MAP_CENTER } from '../core/constants'

const log = createLogger('STORE:LOCATION')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface LocationStore {
  // Active location (what the terrain is showing)
  activeLat: number
  activeLng: number
  mode: LocationMode           // 'gps' | 'exploring'

  // Real GPS position
  gpsLat: number | null        // null until GPS fixes
  gpsLng: number | null
  gpsAltitude_m: number | null // GPS altitude (often inaccurate on phones)
  gpsAccuracy_m: number | null // Horizontal accuracy radius in meters
  gpsPermission: GPSPermission
  gpsWatchId: number | null    // Browser geolocation watch ID

  // Device sensors (compass, tilt)
  sensorData: SensorData

  // Actions
  requestGPS: () => Promise<void>
  stopGPS: () => void
  setExploreLocation: (lat: number, lng: number) => void
  switchToGPS: () => void
  updateSensorData: (data: Partial<SensorData>) => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useLocationStore = create<LocationStore>()((set, get) => ({
  // Default to Colorado Rockies center until GPS fixes
  activeLat: DEFAULT_MAP_CENTER.lat,
  activeLng: DEFAULT_MAP_CENTER.lng,
  mode: 'gps',

  gpsLat: null,
  gpsLng: null,
  gpsAltitude_m: null,
  gpsAccuracy_m: null,
  gpsPermission: 'unknown',
  gpsWatchId: null,

  sensorData: {},

  /**
   * Request GPS permission and start watching for position updates.
   *
   * The browser's Geolocation API is async and permission-gated.
   * We use watchPosition() instead of getCurrentPosition() so we get
   * continuous updates as the device moves.
   */
  requestGPS: () => {
    log.info('Requesting GPS permission...')

    if (!navigator.geolocation) {
      log.warn('Geolocation API not available on this device/browser')
      set({ gpsPermission: 'unavailable' })
      return Promise.resolve()
    }

    // Stop any existing watch before starting a new one
    const { gpsWatchId } = get()
    if (gpsWatchId !== null) {
      log.debug('Stopping existing GPS watch', { watchId: gpsWatchId })
      navigator.geolocation.clearWatch(gpsWatchId)
    }

    // Return a promise that resolves on the FIRST position fix (or error),
    // so callers can await it and know GPS is ready.
    return new Promise<void>((resolve) => {
      let resolved = false

      try {
        const watchId = navigator.geolocation.watchPosition(
          (position) => {
            const { latitude, longitude, altitude, accuracy } = position.coords
            log.info('GPS position update', {
              lat: latitude.toFixed(5),
              lng: longitude.toFixed(5),
              accuracy: accuracy ? `${accuracy.toFixed(0)}m` : 'unknown',
              altitude: altitude ? `${altitude.toFixed(0)}m` : 'unknown',
            })

            const newState: Partial<LocationStore> = {
              gpsLat: latitude,
              gpsLng: longitude,
              gpsAltitude_m: altitude,
              gpsAccuracy_m: accuracy,
              gpsPermission: 'granted',
            }

            // Only update active location if in GPS mode (not exploring)
            if (get().mode === 'gps') {
              newState.activeLat = latitude
              newState.activeLng = longitude
            }

            set(newState)

            // Resolve on first fix so callers know GPS position is available
            if (!resolved) {
              resolved = true
              resolve()
            }
          },

          (error) => {
            log.error('GPS position error', {
              code: error.code,
              message: error.message,
            })

            if (isPermissionDenied(error)) {
              const permError = new LocationPermissionError()
              log.warn('GPS permission denied — will use simulated position', permError)
              set({ gpsPermission: 'denied', gpsWatchId: null })
            } else {
              const gpsError = new GPSError(error.message, { code: error.code })
              log.warn('GPS error — will use simulated position', gpsError)
            }

            // Resolve even on error so callers don't hang forever
            if (!resolved) {
              resolved = true
              resolve()
            }
          },

          {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0,
          },
        )

        log.info('GPS watch started', { watchId })
        set({ gpsWatchId: watchId })

      } catch (err) {
        log.error('Failed to start GPS watch', err)
        set({ gpsPermission: 'unavailable' })
        if (!resolved) {
          resolved = true
          resolve()
        }
      }
    })
  },

  stopGPS: () => {
    const { gpsWatchId } = get()
    if (gpsWatchId !== null) {
      log.info('Stopping GPS watch', { watchId: gpsWatchId })
      navigator.geolocation.clearWatch(gpsWatchId)
      set({ gpsWatchId: null })
    }
  },

  /**
   * Set an explore location from MAP screen click.
   * Switches mode to 'exploring' — the terrain will show this location.
   */
  setExploreLocation: (lat, lng) => {
    log.info('Explore location set', {
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
    })
    set({
      activeLat: lat,
      activeLng: lng,
      mode: 'exploring',
    })
  },

  /**
   * Return to GPS mode.
   * If we have a GPS fix, switch to that position.
   * Otherwise keep the current active position.
   */
  switchToGPS: () => {
    const { gpsLat, gpsLng } = get()
    log.info('Switching to GPS mode', {
      hasGPSFix: gpsLat !== null,
      gpsLat: gpsLat?.toFixed(5),
      gpsLng: gpsLng?.toFixed(5),
    })

    if (gpsLat !== null && gpsLng !== null) {
      set({ activeLat: gpsLat, activeLng: gpsLng, mode: 'gps' })
    } else {
      set({ mode: 'gps' })
    }
  },

  updateSensorData: (data) => {
    log.debug('Sensor data updated', data)
    set((state) => ({ sensorData: { ...state.sensorData, ...data } }))
  },
}))

// ─── Selector Hooks ───────────────────────────────────────────────────────────

/** Returns the active position as a LatLng object */
export function useActiveLocation(): LatLng {
  return useLocationStore((state) => ({
    lat: state.activeLat,
    lng: state.activeLng,
  }))
}

/** Returns true if the user is in exploring mode */
export function useIsExploring(): boolean {
  return useLocationStore((state) => state.mode === 'exploring')
}
