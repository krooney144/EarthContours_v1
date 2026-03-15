/**
 * EarthContours — Store Barrel Export
 *
 * Re-exports all stores from a single entry point.
 * Components import from '@/store' instead of '@/store/terrainStore' etc.
 * This makes imports cleaner and lets us restructure stores internally
 * without touching every component file.
 */

export { useSettingsStore } from './settingsStore'
export { useUIStore } from './uiStore'
export { useCameraStore } from './cameraStore'
export { useLocationStore, useActiveLocation, useIsExploring } from './locationStore'
export { useTerrainStore } from './terrainStore'
export { useMapViewStore } from './mapViewStore'
