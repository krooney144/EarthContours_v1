/**
 * EarthContours — Map View Store
 *
 * Shared state for map center position and zoom level.
 * Used by MapScreen (reads + writes via gestures) and B2MapScreen
 * control strips (writes via buttons). Single source of truth so
 * the B2 exhibit table can drive the same map.
 */

import { create } from 'zustand'
import { createLogger } from '../core/logger'
import {
  DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM,
  MAP_MIN_ZOOM, MAP_MAX_ZOOM,
} from '../core/constants'

const log = createLogger('STORE:MAP-VIEW')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat))
}

function wrapLng(lng: number): number {
  return ((lng + 180) % 360 + 360) % 360 - 180
}

function clampZoom(z: number): number {
  return Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, z))
}

// ─── Store Interface ─────────────────────────────────────────────────────────

interface MapViewStore {
  centerLat: number
  centerLng: number
  zoom: number

  setCenterLat: (lat: number) => void
  setCenterLng: (lng: number) => void
  setCenter: (lat: number, lng: number) => void
  setZoom: (zoom: number) => void

  /** Pan by a lat/lng delta — clamps lat, wraps lng */
  pan: (dLat: number, dLng: number) => void

  /** Zoom in by 1 integer step */
  zoomIn: () => void

  /** Zoom out by 1 integer step */
  zoomOut: () => void

  /** Zoom by a fractional amount (e.g. ±0.3 for scroll) */
  zoomBy: (delta: number) => void

  /** Compute a small pan step appropriate for the current zoom level */
  panStep: () => number
}

// ─── Store Implementation ────────────────────────────────────────────────────

export const useMapViewStore = create<MapViewStore>()((set, get) => ({
  centerLat: DEFAULT_MAP_CENTER.lat,
  centerLng: DEFAULT_MAP_CENTER.lng,
  zoom: DEFAULT_MAP_ZOOM,

  setCenterLat: (lat) => set({ centerLat: clampLat(lat) }),
  setCenterLng: (lng) => set({ centerLng: wrapLng(lng) }),

  setCenter: (lat, lng) => {
    set({ centerLat: clampLat(lat), centerLng: wrapLng(lng) })
  },

  setZoom: (z) => set({ zoom: clampZoom(z) }),

  pan: (dLat, dLng) => {
    const { centerLat, centerLng } = get()
    const newLat = clampLat(centerLat + dLat)
    const newLng = wrapLng(centerLng + dLng)
    log.debug('Pan', { dLat: dLat.toFixed(4), dLng: dLng.toFixed(4) })
    set({ centerLat: newLat, centerLng: newLng })
  },

  zoomIn: () => {
    const z = get().zoom
    set({ zoom: clampZoom(Math.floor(z) + 1) })
  },

  zoomOut: () => {
    const z = get().zoom
    set({ zoom: clampZoom(Math.ceil(z) - 1) })
  },

  zoomBy: (delta) => {
    const z = get().zoom
    set({ zoom: clampZoom(z + delta) })
  },

  panStep: () => {
    // Step that scales with zoom — visible nudge at every zoom level
    // At zoom 9: ~0.03° (~3.3 km). At zoom 3: ~2°. At zoom 16: ~0.0003°.
    const z = get().zoom
    return 1.5 / Math.pow(2, z - 1)
  },
}))
