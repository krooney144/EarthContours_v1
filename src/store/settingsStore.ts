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
  showRiverLabels: false,
  showWaterLabels: false,
  showTownLabels: false,        // Off by default per briefing
  showContourLines: true,
  contourAnimation: true,       // Slow pulse on by default
  verticalExaggeration: 1,     // 1× = real scale (no exaggeration baseline)

  // Appearance
  appName: 'Earth Contours',   // Two-word brand name
  colorTheme: 'ocean',
  labelSize: 'medium',
  reduceMotion: false,

  // Location & Sensors
  locationAccuracy: 'high',
  autoDetectRegion: true,

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
  toggleRiverLabels: () => void
  toggleWaterLabels: () => void
  toggleTownLabels: () => void
  toggleContourLines: () => void
  toggleContourAnimation: () => void
  setVerticalExaggeration: (v: VerticalExaggeration) => void
  setAppName: (name: 'Earth Contours' | 'EarthContours' | 'Earthscape') => void
  setColorTheme: (theme: ColorTheme) => void
  setLabelSize: (size: LabelSize) => void
  toggleReduceMotion: () => void
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

      toggleRiverLabels: () => {
        const next = !get().showRiverLabels
        log.info('River labels toggled', { now: next })
        set({ showRiverLabels: next })
      },

      toggleWaterLabels: () => {
        const next = !get().showWaterLabels
        log.info('Water labels toggled', { now: next })
        set({ showWaterLabels: next })
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

      toggleContourAnimation: () => {
        const next = !get().contourAnimation
        log.info('Contour animation toggled', { now: next })
        set({ contourAnimation: next })
      },

      setVerticalExaggeration: (verticalExaggeration) => {
        log.info('Vertical exaggeration changed', { to: `${verticalExaggeration}×` })
        set({ verticalExaggeration })
      },

      setAppName: (appName) => {
        log.info('App name changed', { to: appName })
        set({ appName })
        // Also update the document title
        document.title = appName
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
        showRiverLabels: state.showRiverLabels,
        showWaterLabels: state.showWaterLabels,
        showTownLabels: state.showTownLabels,
        showContourLines: state.showContourLines,
        contourAnimation: state.contourAnimation,
        verticalExaggeration: state.verticalExaggeration,
        appName: state.appName,
        colorTheme: state.colorTheme,
        labelSize: state.labelSize,
        reduceMotion: state.reduceMotion,
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
            appName: state?.appName,
            units: state?.units,
          })
        }
      },
    },
  ),
)
