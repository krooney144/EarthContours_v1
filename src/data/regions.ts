/**
 * EarthContours — Region Registry
 *
 * Defines the two pre-bundled terrain regions.
 * Each region has geographic bounds used for:
 * - Determining which peak data to load
 * - Setting the default map view
 * - Requesting the correct terrain tiles (Session 2)
 *
 * In Session 2, this will be backed by MBTiles bundles.
 * For MVP, it just defines the metadata.
 */

import type { Region } from '../core/types'

export const REGIONS: Region[] = [
  {
    id: 'colorado-rockies',
    name: 'Colorado Rockies',
    description: 'Home of 53 fourteeners — peaks above 14,000 feet. Rocky Mountain National Park, Pikes Peak, and the Continental Divide.',
    center: { lat: 39.0, lng: -105.5 },
    bounds: {
      north: 41.1,
      south: 36.9,
      east:  -102.0,
      west:  -109.1,
    },
  },
  {
    id: 'anchorage-alaska',
    name: 'Anchorage, Alaska',
    description: 'Denali (6,190m / 20,310ft), the highest peak in North America, plus the Alaska Range and Matanuska Glacier.',
    center: { lat: 61.2, lng: -150.0 },
    bounds: {
      north: 63.5,
      south: 59.5,
      east:  -145.5,
      west:  -154.0,
    },
  },
]

export const REGION_MAP = Object.fromEntries(REGIONS.map((r) => [r.id, r]))
