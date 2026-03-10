/**
 * EarthContours — Static Peak Data
 *
 * Real peak names, elevations, and coordinates for Colorado, Alaska, and Washington Cascades.
 * Used as fallback when Overpass API is unavailable (peakLoader.ts handles live queries).
 *
 * Data sources:
 * - Colorado: USGS fourteeners list + NGS data
 * - Alaska: Alaska Range + Wrangell-St. Elias (USGS)
 * - Cascades: USGS + NPS summit data
 *
 * All elevations stored in METERS.
 */

import type { Peak } from '../core/types'

// ─── Colorado Rockies Peaks ───────────────────────────────────────────────────

export const COLORADO_PEAKS: Peak[] = [
  // The Colorado Fourteeners (peaks above 14,000ft / 4,267m)
  { id: 'mt-elbert',       name: 'Mt. Elbert',            lat: 39.1178, lng: -106.4452, elevation_m: 4399, isHighPoint: true },
  { id: 'mt-massive',      name: 'Mt. Massive',           lat: 39.1875, lng: -106.4754, elevation_m: 4396 },
  { id: 'mt-harvard',      name: 'Mt. Harvard',           lat: 38.9239, lng: -106.3206, elevation_m: 4395 },
  { id: 'mt-lincoln',      name: 'Mt. Lincoln',           lat: 39.3514, lng: -106.1114, elevation_m: 4354 },
  { id: 'grays-peak',      name: 'Grays Peak',            lat: 39.6339, lng: -105.8176, elevation_m: 4349 },
  { id: 'mt-antero',       name: 'Mt. Antero',            lat: 38.6742, lng: -106.2461, elevation_m: 4349 },
  { id: 'torreys-peak',    name: 'Torreys Peak',          lat: 39.6428, lng: -105.8212, elevation_m: 4349 },
  { id: 'castle-peak',     name: 'Castle Peak',           lat: 39.0097, lng: -106.8614, elevation_m: 4349 },
  { id: 'quandary-peak',   name: 'Quandary Peak',         lat: 39.3972, lng: -106.1061, elevation_m: 4348 },
  { id: 'mt-evans',        name: 'Mt. Evans',             lat: 39.5883, lng: -105.6438, elevation_m: 4348 },
  { id: 'longs-peak',      name: 'Longs Peak',            lat: 40.2550, lng: -105.6151, elevation_m: 4346 },
  { id: 'mt-wilson',       name: 'Mt. Wilson',            lat: 37.8392, lng: -107.9917, elevation_m: 4342 },
  { id: 'mt-shavano',      name: 'Mt. Shavano',           lat: 38.6192, lng: -106.2394, elevation_m: 4337 },
  { id: 'mt-tabeguache',   name: 'Mt. Tabeguache',        lat: 38.6253, lng: -106.2506, elevation_m: 4369 },
  { id: 'mt-princeton',    name: 'Mt. Princeton',         lat: 38.7492, lng: -106.2419, elevation_m: 4327 },
  { id: 'mt-yale',         name: 'Mt. Yale',              lat: 38.8439, lng: -106.3133, elevation_m: 4327 },
  { id: 'mt-cameron',      name: 'Mt. Cameron',           lat: 39.3469, lng: -106.1181, elevation_m: 4328 },
  { id: 'mt-bross',        name: 'Mt. Bross',             lat: 39.3353, lng: -106.1053, elevation_m: 4320 },
  { id: 'kit-carson-peak', name: 'Kit Carson Peak',       lat: 37.9797, lng: -105.6022, elevation_m: 4317 },
  { id: 'el-diente',       name: 'El Diente Peak',        lat: 37.8400, lng: -108.0067, elevation_m: 4315 },
  { id: 'maroon-peak',     name: 'Maroon Peak',           lat: 39.0708, lng: -106.9886, elevation_m: 4315 },
  { id: 'north-maroon',    name: 'North Maroon Peak',     lat: 39.0772, lng: -106.9872, elevation_m: 4311 },
  { id: 'pyramid-peak',    name: 'Pyramid Peak',          lat: 39.0714, lng: -106.9500, elevation_m: 4273 },
  { id: 'south-maroon',    name: 'South Maroon',          lat: 39.0628, lng: -106.9858, elevation_m: 4316 },
  { id: 'humboldt-peak',   name: 'Humboldt Peak',         lat: 37.9764, lng: -105.5556, elevation_m: 4286 },
  { id: 'pikes-peak',      name: 'Pikes Peak',            lat: 38.8406, lng: -105.0442, elevation_m: 4302 },
  { id: 'snowmass-mtn',    name: 'Snowmass Mtn',          lat: 39.1197, lng: -107.0675, elevation_m: 4295 },
  { id: 'windom-peak',     name: 'Windom Peak',           lat: 37.6214, lng: -107.5917, elevation_m: 4292 },
  { id: 'san-luis-peak',   name: 'San Luis Peak',         lat: 37.9869, lng: -106.9314, elevation_m: 4278 },
  { id: 'holy-cross',      name: 'Mt. of the Holy Cross', lat: 39.4664, lng: -106.4817, elevation_m: 4269 },
  // Additional prominent Colorado summits
  { id: 'capitol-peak',    name: 'Capitol Peak',          lat: 39.1503, lng: -107.0828, elevation_m: 4307 },
  { id: 'crestone-peak',   name: 'Crestone Peak',         lat: 37.9666, lng: -105.5869, elevation_m: 4357 },
  { id: 'crestone-needle', name: 'Crestone Needle',       lat: 37.9617, lng: -105.5757, elevation_m: 4327 },
  { id: 'blanca-peak',     name: 'Blanca Peak',           lat: 37.5775, lng: -105.4852, elevation_m: 4372 },
  { id: 'little-bear',     name: 'Little Bear Peak',      lat: 37.5672, lng: -105.4967, elevation_m: 4278 },
  { id: 'culebra-peak',    name: 'Culebra Peak',          lat: 37.1225, lng: -105.1869, elevation_m: 4270 },
]

// ─── Alaska Peaks ─────────────────────────────────────────────────────────────

export const ALASKA_PEAKS: Peak[] = [
  // Alaska Range — Denali massif
  { id: 'denali',          name: 'Denali',           lat: 63.0692, lng: -151.0070, elevation_m: 6190, isHighPoint: true },
  { id: 'mt-foraker',      name: 'Mt. Foraker',      lat: 62.9608, lng: -151.3986, elevation_m: 5304 },
  { id: 'mt-hunter',       name: 'Mt. Hunter',       lat: 62.9483, lng: -151.0917, elevation_m: 4442 },
  { id: 'mt-huntington',   name: 'Mt. Huntington',   lat: 62.9100, lng: -150.9031, elevation_m: 3731 },
  { id: 'mt-russell',      name: 'Mt. Russell',      lat: 63.0086, lng: -151.3419, elevation_m: 3581 },
  { id: 'mt-silverthrone', name: 'Mt. Silverthrone', lat: 63.2142, lng: -150.8572, elevation_m: 3886 },
  { id: 'mt-mather',       name: 'Mt. Mather',       lat: 63.2222, lng: -151.0789, elevation_m: 3962 },
  { id: 'mt-carpe',        name: 'Mt. Carpe',        lat: 63.2208, lng: -151.2064, elevation_m: 4145 },
  // Wrangell-St. Elias peaks
  { id: 'mt-blackburn',    name: 'Mt. Blackburn',    lat: 61.7311, lng: -143.4275, elevation_m: 4996 },
  { id: 'mt-sanford',      name: 'Mt. Sanford',      lat: 62.2133, lng: -144.1314, elevation_m: 4949 },
  { id: 'mt-wrangell',     name: 'Mt. Wrangell',     lat: 62.0058, lng: -144.0153, elevation_m: 4317 },
  { id: 'mt-drum',         name: 'Mt. Drum',         lat: 62.1142, lng: -144.6361, elevation_m: 3661 },
  // Chugach + Kenai
  { id: 'pioneer-peak',    name: 'Pioneer Peak',     lat: 61.5706, lng: -148.8625, elevation_m: 2566 },
  { id: 'matanuska-pk',    name: 'Matanuska Peak',   lat: 61.7706, lng: -148.3506, elevation_m: 2804 },
  // Volcanic arc (Cook Inlet)
  { id: 'mt-spurr',        name: 'Mt. Spurr',        lat: 61.2992, lng: -152.2517, elevation_m: 3374 },
  { id: 'mt-redoubt',      name: 'Mt. Redoubt',      lat: 60.4853, lng: -152.7439, elevation_m: 3108 },
  { id: 'mt-iliamna',      name: 'Mt. Iliamna',      lat: 60.0322, lng: -153.0919, elevation_m: 3053 },
  { id: 'mt-augustine',    name: 'Mt. Augustine',    lat: 59.3628, lng: -153.4350, elevation_m: 1252 },
]

// ─── Washington Cascades Peaks ────────────────────────────────────────────────

export const CASCADES_PEAKS: Peak[] = [
  // Washington State Cascades
  { id: 'mt-rainier',      name: 'Mt. Rainier',      lat: 46.8529, lng: -121.7269, elevation_m: 4392, isHighPoint: true },
  { id: 'mt-baker',        name: 'Mt. Baker',        lat: 48.7767, lng: -121.8144, elevation_m: 3286 },
  { id: 'glacier-peak',    name: 'Glacier Peak',     lat: 48.1124, lng: -121.1145, elevation_m: 3213 },
  { id: 'mt-adams',        name: 'Mt. Adams',        lat: 46.2022, lng: -121.4907, elevation_m: 3743 },
  { id: 'mt-st-helens',    name: 'Mt. St. Helens',   lat: 46.1912, lng: -122.1944, elevation_m: 2549 },
  { id: 'jack-mtn',        name: 'Jack Mountain',    lat: 48.7802, lng: -120.9094, elevation_m: 2751 },
  { id: 'bonanza-peak',    name: 'Bonanza Peak',     lat: 48.1872, lng: -120.5739, elevation_m: 2808 },
  { id: 'mt-stuart',       name: 'Mt. Stuart',       lat: 47.4724, lng: -120.8997, elevation_m: 2734 },
  // Oregon Cascades (visible from southern Washington viewpoints)
  { id: 'mt-hood',         name: 'Mt. Hood',         lat: 45.3735, lng: -121.6960, elevation_m: 3426 },
  { id: 'mt-jefferson',    name: 'Mt. Jefferson',    lat: 44.6741, lng: -121.7996, elevation_m: 3199 },
  { id: 'mt-mcloughlin',   name: 'Mt. McLoughlin',   lat: 42.4461, lng: -122.3164, elevation_m: 2894 },
]

