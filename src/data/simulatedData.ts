/**
 * EarthContours — Simulated Peak & River Data
 *
 * Real peak names, elevations, and coordinates for Colorado and Alaska.
 * In Session 2, this will be loaded from a GeoJSON file bundled with the app.
 *
 * Data sources used to compile this list:
 * - Colorado: List of Colorado fourteeners (https://en.wikipedia.org/wiki/List_of_Colorado_fourteeners)
 * - Alaska: Alaska Range summits (USGS)
 *
 * All elevations stored in METERS. The display layer converts to feet/meters
 * based on user's unit preference.
 */

import type { Peak, River } from '../core/types'

// ─── Colorado Rockies Peaks ───────────────────────────────────────────────────

export const COLORADO_PEAKS: Peak[] = [
  // The Colorado Fourteeners (peaks above 14,000ft / 4,267m)
  { id: 'mt-elbert',       name: 'Mt. Elbert',       lat: 39.1178, lng: -106.4452, elevation_m: 4399, isHighPoint: true },
  { id: 'mt-massive',      name: 'Mt. Massive',      lat: 39.1875, lng: -106.4754, elevation_m: 4396 },
  { id: 'mt-harvard',      name: 'Mt. Harvard',      lat: 38.9239, lng: -106.3206, elevation_m: 4395 },
  { id: 'mt-lincoln',      name: 'Mt. Lincoln',      lat: 39.3514, lng: -106.1114, elevation_m: 4354 },
  { id: 'grays-peak',      name: 'Grays Peak',       lat: 39.6339, lng: -105.8176, elevation_m: 4349 },
  { id: 'mt-antero',       name: 'Mt. Antero',       lat: 38.6742, lng: -106.2461, elevation_m: 4349 },
  { id: 'torreys-peak',    name: 'Torreys Peak',     lat: 39.6428, lng: -105.8212, elevation_m: 4349 },
  { id: 'castle-peak',     name: 'Castle Peak',      lat: 39.0097, lng: -106.8614, elevation_m: 4349 },
  { id: 'quandary-peak',   name: 'Quandary Peak',    lat: 39.3972, lng: -106.1061, elevation_m: 4348 },
  { id: 'mt-evans',        name: 'Mt. Evans',        lat: 39.5883, lng: -105.6438, elevation_m: 4348 },
  { id: 'longs-peak',      name: "Longs Peak",       lat: 40.2550, lng: -105.6151, elevation_m: 4346 },
  { id: 'mt-wilson',       name: 'Mt. Wilson',       lat: 37.8392, lng: -107.9917, elevation_m: 4342 },
  { id: 'mt-cameron',      name: 'Mt. Cameron',      lat: 39.3469, lng: -106.1181, elevation_m: 4328 },
  { id: 'mt-shavano',      name: 'Mt. Shavano',      lat: 38.6192, lng: -106.2394, elevation_m: 4337 },
  { id: 'mt-tabeguache',   name: 'Mt. Tabeguache',   lat: 38.6253, lng: -106.2506, elevation_m: 4369 },
  { id: 'mt-princeton',    name: 'Mt. Princeton',    lat: 38.7492, lng: -106.2419, elevation_m: 4327 },
  { id: 'mt-yale',         name: 'Mt. Yale',         lat: 38.8439, lng: -106.3133, elevation_m: 4327 },
  { id: 'mt-bross',        name: 'Mt. Bross',        lat: 39.3353, lng: -106.1053, elevation_m: 4320 },
  { id: 'kit-carson-peak', name: 'Kit Carson Peak',  lat: 37.9797, lng: -105.6022, elevation_m: 4317 },
  { id: 'el-diente',       name: 'El Diente Peak',   lat: 37.8400, lng: -108.0067, elevation_m: 4315 },
  { id: 'maroon-peak',     name: 'Maroon Peak',      lat: 39.0708, lng: -106.9886, elevation_m: 4315 },
  { id: 'north-maroon',    name: 'North Maroon Peak',lat: 39.0772, lng: -106.9872, elevation_m: 4311 },
  { id: 'pyramid-peak',    name: 'Pyramid Peak',     lat: 39.0714, lng: -106.9500, elevation_m: 4273 },
  { id: 'south-maroon',    name: 'South Maroon',     lat: 39.0628, lng: -106.9858, elevation_m: 4316 },
  { id: 'humboldt-peak',   name: 'Humboldt Peak',    lat: 37.9764, lng: -105.5556, elevation_m: 4286 },
  { id: 'pikes-peak',      name: 'Pikes Peak',       lat: 38.8406, lng: -105.0442, elevation_m: 4302 },
  { id: 'snowmass-mtn',    name: 'Snowmass Mtn',     lat: 39.1197, lng: -107.0675, elevation_m: 4295 },
  { id: 'windom-peak',     name: 'Windom Peak',      lat: 37.6214, lng: -107.5917, elevation_m: 4292 },
  { id: 'san-luis-peak',   name: 'San Luis Peak',    lat: 37.9869, lng: -106.9314, elevation_m: 4278 },
  { id: 'holy-cross',      name: 'Mt. of the Holy Cross', lat: 39.4664, lng: -106.4817, elevation_m: 4269 },
]

// ─── Alaska Peaks ─────────────────────────────────────────────────────────────

export const ALASKA_PEAKS: Peak[] = [
  { id: 'denali',         name: 'Denali',          lat: 63.0692, lng: -151.0070, elevation_m: 6190, isHighPoint: true },
  { id: 'mt-foraker',     name: 'Mt. Foraker',     lat: 62.9608, lng: -151.3986, elevation_m: 5304 },
  { id: 'mt-hunter',      name: 'Mt. Hunter',      lat: 62.9483, lng: -151.0917, elevation_m: 4442 },
  { id: 'mt-huntington',  name: 'Mt. Huntington',  lat: 62.9100, lng: -150.9031, elevation_m: 3731 },
  { id: 'mt-russell',     name: 'Mt. Russell',     lat: 63.0086, lng: -151.3419, elevation_m: 3581 },
  { id: 'mt-silverthrone',name: 'Mt. Silverthrone',lat: 63.2142, lng: -150.8572, elevation_m: 3886 },
  { id: 'mt-mather',      name: 'Mt. Mather',      lat: 63.2222, lng: -151.0789, elevation_m: 3962 },
  { id: 'mt-carpe',       name: 'Mt. Carpe',       lat: 63.2208, lng: -151.2064, elevation_m: 4145 },
  { id: 'pioneer-peak',   name: 'Pioneer Peak',    lat: 61.5706, lng: -148.8625, elevation_m: 2566 },
  { id: 'matanuska-pk',   name: 'Matanuska Peak',  lat: 61.7706, lng: -148.3506, elevation_m: 2804 },
  { id: 'mt-spurr',       name: 'Mt. Spurr',       lat: 61.2992, lng: -152.2517, elevation_m: 3374 },
  { id: 'mt-redoubt',     name: 'Mt. Redoubt',     lat: 60.4853, lng: -152.7439, elevation_m: 3108 },
  { id: 'mt-iliamna',     name: 'Mt. Iliamna',     lat: 60.0322, lng: -153.0919, elevation_m: 3053 },
]

// ─── Colorado Rivers ──────────────────────────────────────────────────────────

export const COLORADO_RIVERS: River[] = [
  {
    id: 'boulder-creek',
    name: 'Boulder Creek',
    points: [
      { lat: 40.0150, lng: -105.5500 },
      { lat: 40.0100, lng: -105.3800 },
      { lat: 40.0100, lng: -105.2800 },
      { lat: 40.0150, lng: -105.2500 },
    ],
  },
  {
    id: 'arkansas-river',
    name: 'Arkansas River',
    points: [
      { lat: 39.3400, lng: -106.1500 },
      { lat: 38.8500, lng: -106.1000 },
      { lat: 38.5000, lng: -105.9000 },
      { lat: 38.3000, lng: -105.6000 },
    ],
  },
  {
    id: 'south-platte',
    name: 'South Platte River',
    points: [
      { lat: 39.5000, lng: -106.0000 },
      { lat: 39.4000, lng: -105.7000 },
      { lat: 39.3500, lng: -105.3500 },
    ],
  },
]

// ─── Alaska Rivers ────────────────────────────────────────────────────────────

export const ALASKA_RIVERS: River[] = [
  {
    id: 'matanuska-river',
    name: 'Matanuska River',
    points: [
      { lat: 61.7500, lng: -148.2000 },
      { lat: 61.5500, lng: -148.5000 },
      { lat: 61.4500, lng: -149.0000 },
    ],
  },
  {
    id: 'susitna-river',
    name: 'Susitna River',
    points: [
      { lat: 62.5000, lng: -150.5000 },
      { lat: 62.0000, lng: -150.2000 },
      { lat: 61.5000, lng: -150.5000 },
      { lat: 61.2000, lng: -150.3000 },
    ],
  },
]
