/**
 * EarthContours — Settings Store
 *
 * Persists user preferences to localStorage using Zustand's persist middleware.
 * All settings have sensible defaults from the briefing document.
 *
 * Why Zustand instead of Redux or Context?
 * - Much less boilerplate than Redux
 * - Better TypeScript support than Context + useReducer
 * - Built-in localStorage persistence with the persist middleware
 * - Selectors prevent unnecessary re-renders
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  AppSettings,
  UnitSystem,
  CoordFormat,
  ColorTheme,
  LabelSize,
  TargetFPS,
  BatteryMode,
  GPSAccuracy,
  DataResolution,
  VerticalExaggeration,
} from '../core/types'
import { createLogger } from '../core/logger'
import { DEFAULT_REGION_ID } from '../core/constants'

const log = createLogger('STORE:SETTINGS')

// ─── Default Settings (from briefing) ────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  // Units & Measurements
  units: 'imperial',           // Imperial by default (ft, miles)
  coordFormat: 'decimal',      // Decimal degrees by default

  // Map & Terrain Display
  showPeakLabels: true,
  showRivers: true,
  showLakes: true,
  showGlaciers: false,
  showCoastlines: true,
  showTownLabels: false,        // Off by default per briefing
  showContourLines: true,
  showBandLines: false,           // Depth band ridgeline strokes in SCAN
  showFill: false,                // Terrain fill below ridgelines in SCAN
  solidTerrain: true,            // Solid terrain mesh in EXPLORE (off = contour lines only)
  contourAnimation: true,       // Slow pulse on by default
  verticalExaggeration: 4,     // 4× default — real mountains visible without being overwhelming

  // Appearance
  colorTheme: 'ocean',
  labelSize: 'medium',
  reduceMotion: false,

  // Location & Sensors
  locationAccuracy: 'high',
  autoDetectRegion: true,

  // Debug & Developer
  showDebugPanel: false,

  // Performance & Battery
  batteryMode: 'auto',
  targetFPS: 'auto',

  // Data & Downloads
  downloadOnWifiOnly: true,    // Safe default — don't burn data
  dataResolution: '10m',
  defaultRegionId: DEFAULT_REGION_ID,
}

// ─── Store Interface ──────────────────────────────────────────────────────────

interface SettingsStore extends AppSettings {
  // Actions — functions to update state
  setUnits: (units: UnitSystem) => void
  setCoordFormat: (format: CoordFormat) => void
  togglePeakLabels: () => void
  toggleRivers: () => void
  toggleLakes: () => void
  toggleGlaciers: () => void
  toggleCoastlines: () => void
  toggleTownLabels: () => void
  toggleContourLines: () => void
  toggleBandLines: () => void
  toggleFill: () => void
  toggleSolidTerrain: () => void
  toggleContourAnimation: () => void
  setVerticalExaggeration: (v: VerticalExaggeration) => void
  setColorTheme: (theme: ColorTheme) => void
  setLabelSize: (size: LabelSize) => void
  toggleReduceMotion: () => void
  toggleDebugPanel: () => void
  setLocationAccuracy: (accuracy: GPSAccuracy) => void
  toggleAutoDetectRegion: () => void
  setBatteryMode: (mode: BatteryMode) => void
  setTargetFPS: (fps: TargetFPS) => void
  toggleDownloadOnWifiOnly: () => void
  setDataResolution: (res: DataResolution) => void
  setDefaultRegion: (regionId: string) => void
  resetToDefaults: () => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStore>()(
  /**
   * persist() wraps our store with localStorage sync.
   * When the page loads, it reads saved settings from 'earthcontours-settings'.
   * When settings change, it writes them back automatically.
   */
  persist(
    (set, get) => ({
      // Spread all defaults as initial state
      ...DEFAULT_SETTINGS,

      setUnits: (units) => {
        log.info('Units changed', { from: get().units, to: units })
        set({ units })
      },

      setCoordFormat: (coordFormat) => {
        log.info('Coordinate format changed', { to: coordFormat })
        set({ coordFormat })
      },

      togglePeakLabels: () => {
        const next = !get().showPeakLabels
        log.info('Peak labels toggled', { now: next })
        set({ showPeakLabels: next })
      },

      toggleRivers: () => {
        const next = !get().showRivers
        log.info('Rivers toggled', { now: next })
        set({ showRivers: next })
      },

      toggleLakes: () => {
        const next = !get().showLakes
        log.info('Lakes toggled', { now: next })
        set({ showLakes: next })
      },

      toggleGlaciers: () => {
        const next = !get().showGlaciers
        log.info('Glaciers toggled', { now: next })
        set({ showGlaciers: next })
      },

      toggleCoastlines: () => {
        const next = !get().showCoastlines
        log.info('Coastlines toggled', { now: next })
        set({ showCoastlines: next })
      },

      toggleTownLabels: () => {
        const next = !get().showTownLabels
        log.info('Town labels toggled', { now: next })
        set({ showTownLabels: next })
      },

      toggleContourLines: () => {
        const next = !get().showContourLines
        log.info('Contour lines toggled', { now: next })
        set({ showContourLines: next })
      },

      toggleBandLines: () => {
        const next = !get().showBandLines
        log.info('Band lines toggled', { now: next })
        set({ showBandLines: next })
      },

      toggleFill: () => {
        const next = !get().showFill
        log.info('Fill toggled', { now: next })
        set({ showFill: next })
      },

      toggleSolidTerrain: () => {
        const next = !get().solidTerrain
        log.info('Solid terrain toggled', { now: next })
        set({ solidTerrain: next })
      },

      toggleContourAnimation: () => {
        const next = !get().contourAnimation
        log.info('Contour animation toggled', { now: next })
        set({ contourAnimation: next })
      },

      setVerticalExaggeration: (verticalExaggeration) => {
        log.info('Vertical exaggeration changed', { to: `${verticalExaggeration}×` })
        set({ verticalExaggeration })
      },

      setColorTheme: (colorTheme) => {
        log.info('Color theme changed', { to: colorTheme })
        set({ colorTheme })
      },

      setLabelSize: (labelSize) => {
        log.info('Label size changed', { to: labelSize })
        set({ labelSize })
      },

      toggleReduceMotion: () => {
        const next = !get().reduceMotion
        log.info('Reduce motion toggled', { now: next })
        set({ reduceMotion: next })
      },

      toggleDebugPanel: () => {
        const next = !get().showDebugPanel
        log.info('Debug panel toggled', { now: next })
        set({ showDebugPanel: next })
      },

      setLocationAccuracy: (locationAccuracy) => {
        log.info('Location accuracy changed', { to: locationAccuracy })
        set({ locationAccuracy })
      },

      toggleAutoDetectRegion: () => {
        const next = !get().autoDetectRegion
        log.info('Auto-detect region toggled', { now: next })
        set({ autoDetectRegion: next })
      },

      setBatteryMode: (batteryMode) => {
        log.info('Battery mode changed', { to: batteryMode })
        set({ batteryMode })
      },

      setTargetFPS: (targetFPS) => {
        log.info('Target FPS changed', { to: targetFPS })
        set({ targetFPS })
      },

      toggleDownloadOnWifiOnly: () => {
        const next = !get().downloadOnWifiOnly
        log.info('WiFi-only download toggled', { now: next })
        set({ downloadOnWifiOnly: next })
      },

      setDataResolution: (dataResolution) => {
        log.info('Data resolution changed', { to: dataResolution })
        set({ dataResolution })
      },

      setDefaultRegion: (defaultRegionId) => {
        log.info('Default region changed', { to: defaultRegionId })
        set({ defaultRegionId })
      },

      resetToDefaults: () => {
        log.warn('Settings reset to defaults!')
        set(DEFAULT_SETTINGS)
      },
    }),
    {
      name: 'earthcontours-settings',      // localStorage key
      version: 4,                          // bump when persisted shape changes
      /**
       * Migrations:
       * v1→v2: snap old verticalExaggeration values to new set (1|2|4|10|20).
       * v2→v3: replace showRiverLabels + showWaterLabels with showRivers + showLakes + showGlaciers.
       * v3→v4: add showFill (default false), showBandLines default changed to false.
       */
      migrate: (persisted: unknown, fromVersion: number) => {
        const state = persisted as Record<string, unknown>
        if (fromVersion < 2 && typeof state.verticalExaggeration === 'number') {
          const VALID: VerticalExaggeration[] = [1, 2, 4, 10, 20]
          const old = state.verticalExaggeration as number
          const snapped = VALID.reduce((best, v) =>
            Math.abs(v - old) < Math.abs(best - old) ? v : best
          )
          log.info('Migrating verticalExaggeration', { from: old, to: snapped })
          state.verticalExaggeration = snapped
        }
        if (fromVersion < 4) {
          log.info('Migrating settings v3→v4: add showFill, showBandLines default off')
          if (state.showFill === undefined) state.showFill = false
          if (state.showBandLines === undefined) state.showBandLines = false
        }
        if (fromVersion < 3) {
          log.info('Migrating water settings v2→v3')
          // Map old toggles to new: if either was on, turn on the corresponding new toggle
          state.showRivers = state.showRiverLabels ?? true
          state.showLakes = state.showWaterLabels ?? true
          state.showGlaciers = false
          delete state.showRiverLabels
          delete state.showWaterLabels
        }
        return state as unknown as AppSettings
      },
      storage: createJSONStorage(() => {   // Use localStorage
        try {
          return localStorage
        } catch (err) {
          // localStorage unavailable (private browsing, storage full, etc.)
          log.warn('localStorage unavailable, settings will not persist', err)
          // Return a no-op storage that doesn't throw
          return {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
          }
        }
      }),
      // Only persist the settings values, not the action functions
      partialize: (state) => ({
        units: state.units,
        coordFormat: state.coordFormat,
        showPeakLabels: state.showPeakLabels,
        showRivers: state.showRivers,
        showLakes: state.showLakes,
        showGlaciers: state.showGlaciers,
        showCoastlines: state.showCoastlines,
        showTownLabels: state.showTownLabels,
        showContourLines: state.showContourLines,
        showBandLines: state.showBandLines,
        showFill: state.showFill,
        solidTerrain: state.solidTerrain,
        contourAnimation: state.contourAnimation,
        verticalExaggeration: state.verticalExaggeration,
        colorTheme: state.colorTheme,
        labelSize: state.labelSize,
        reduceMotion: state.reduceMotion,
        showDebugPanel: state.showDebugPanel,
        locationAccuracy: state.locationAccuracy,
        autoDetectRegion: state.autoDetectRegion,
        batteryMode: state.batteryMode,
        targetFPS: state.targetFPS,
        downloadOnWifiOnly: state.downloadOnWifiOnly,
        dataResolution: state.dataResolution,
        defaultRegionId: state.defaultRegionId,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          log.error('Failed to rehydrate settings from localStorage', error)
        } else {
          log.info('Settings loaded from localStorage', {
            units: state?.units,
          })
        }
      },
    },
  ),
)
