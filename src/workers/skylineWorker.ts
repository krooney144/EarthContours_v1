/// <reference lib="webworker" />

/**
 * EarthContours — Skyline Web Worker
 *
 * Pre-computes a full 360° terrain skyline for the SCAN screen.
 * Runs in a separate thread so the UI stays responsive during the
 * ~1–2 s computation.
 *
 * ── Algorithm ──────────────────────────────────────────────────────────────
 *
 *  Phase 1 — Tile prefetch:
 *    Fetch AWS Terrarium tiles for z15/z14/z13/z11/z9/z8 in parallel.
 *    Uses createImageBitmap + OffscreenCanvas for PNG decoding (worker-safe).
 *
 *  Phase 2 — Build distance step arrays:
 *    Standard pass (500m→400km @ 1.015×), hi-res pass (500m→31km @ 1.01×),
 *    immediate pass (10m→1km @ 1.005× at 720 azimuths).
 *
 *  Phase 3 — Standard resolution skyline (1440 azimuths, full range)
 *  Phase 4 — High-res pass (2880 azimuths, 500m–31km for bands with resolution=8)
 *  Phase 4a — Immediate pass (720 azimuths, 10m–1km for immediate band)
 *  Phase 5 — Pack crossing data into flat transferable arrays
 *
 *  Contour intervals: 20ft (immediate) → 50ft → 100ft → 200ft → 500ft → 1000ft → 2000ft (far)
 *
 *  Output: SkylineData with transferable ArrayBuffers (zero-copy to main thread).
 *
 * ── Message Protocol ───────────────────────────────────────────────────────
 *
 *  Main → Worker:  SkylineRequest
 *  Worker → Main:  { type:'progress', phase, progress }
 *                  { type:'complete',  skyline: SkylineData }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const AWS_BASE      = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const TILE_PX       = 256
const EARTH_R       = 6_371_000   // metres
const REFRACTION_K  = 0.13
const DEG_TO_RAD    = Math.PI / 180
// NW-45° sun direction (ENU: x=east, y=up, z=north)
const LIGHT_X = -0.5, LIGHT_Y = 0.707, LIGHT_Z = 0.5

// ─── Contour Intervals Per Band ──────────────────────────────────────────────

/** Contour interval in metres for each depth band index.
 *  Progressive density: dense where visible (near), sparse where faded (far).
 *  immediate = 20ft, ultra-near = 50ft, near = 100ft, mid-near = 200ft,
 *  mid = 500ft, mid-far = 1000ft, far = 2000ft. */
const CONTOUR_INTERVALS_M: number[] = [
  6.096,   // immediate:  20ft
  15.24,   // ultra-near: 50ft
  30.48,   // near:       100ft
  60.96,   // mid-near:   200ft
  152.4,   // mid:        500ft
  304.8,   // mid-far:    1000ft
  609.6,   // far:        2000ft
]

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkylineRequest {
  viewerLat:    number
  viewerLng:    number
  viewerElev:   number
  /** Copy of the region elevation grid sent from main thread */
  meshElevations: Float32Array
  meshWidth:    number
  meshHeight:   number
  meshBounds:   { north: number; south: number; east: number; west: number }
  /** Steps per degree — 2 = 0.5°/step (720 azimuths) */
  resolution:   number
  /** Maximum ray distance in metres */
  maxRange:     number
}

/** Depth band distance config — mirrors DEPTH_BANDS from types.ts */
interface BandConfig {
  label:      string
  minDist:    number
  maxDist:    number
  resolution?: number   // Per-band azimuth resolution override
}

const DEPTH_BANDS: BandConfig[] = [
  { label: 'immediate',  minDist: 0,       maxDist: 1_000,   resolution: 2 },  // 0–1 km     (0.5°, 720 az)
  { label: 'ultra-near', minDist: 500,     maxDist: 4_500,   resolution: 8 },  // 0.5–4.5 km (0.125°, 2880 az)
  { label: 'near',       minDist: 4_000,   maxDist: 10_500,  resolution: 8 },  // 4–10.5 km  (0.125°, 2880 az)
  { label: 'mid-near',   minDist: 10_000,  maxDist: 31_000,  resolution: 8 },  // 10–31 km   (0.125°, 2880 az)
  { label: 'mid',        minDist: 30_000,  maxDist: 81_000  },                  // 30–81 km   (0.25°, 1440 az)
  { label: 'mid-far',    minDist: 80_000,  maxDist: 152_000 },                  // 80–152 km  (0.25°, 1440 az)
  { label: 'far',        minDist: 150_000, maxDist: 400_000 },                  // 150–400 km (0.25°, 1440 az)
]

interface SkylineBand {
  elevations:  Float32Array
  distances:   Float32Array
  ridgeLats:   Float32Array
  ridgeLngs:   Float32Array
  crossingData:    Float32Array
  crossingOffsets: Uint32Array
  resolution:  number      // Steps per degree for this band
  numAzimuths: number      // 360 × resolution
}

export interface SkylineData {
  /** Max elevation angle (radians) at each azimuth step */
  angles:      Float32Array
  /** Distance to ridgeline (metres) */
  distances:   Float32Array
  /** Hill shade at ridgeline [0–1] */
  shading:     Float32Array
  /** Per-depth-band raw world data (near/mid/far) */
  bands:       SkylineBand[]
  /** Steps per degree used during computation */
  resolution:  number
  /** Total azimuth steps (= 360 × resolution) */
  numAzimuths: number
  computedAt: { lat: number; lng: number; elev: number; groundElev: number; timestamp: number }
}

// ─── In-Worker Tile Cache ─────────────────────────────────────────────────────

const tileCacheW  = new Map<string, Float32Array>()
const pendingW    = new Map<string, Promise<Float32Array | null>>()

async function fetchWorkerTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`
  if (tileCacheW.has(key)) return tileCacheW.get(key)!
  if (pendingW.has(key))   return pendingW.get(key)!

  const p = (async (): Promise<Float32Array | null> => {
    try {
      const resp = await fetch(`${AWS_BASE}/${key}.png`)
      if (!resp.ok) return null
      const blob   = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(TILE_PX, TILE_PX)
      const ctx    = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX)
      const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX)
      const elevations = new Float32Array(TILE_PX * TILE_PX)
      for (let i = 0; i < TILE_PX * TILE_PX; i++) {
        elevations[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768
      }
      tileCacheW.set(key, elevations)
      return elevations
    } catch { return null }
  })()

  pendingW.set(key, p)
  const result = await p
  pendingW.delete(key)
  return result
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function latLngToTileXY(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const x    = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom))
  const latR = (lat * Math.PI) / 180
  const y    = Math.floor(
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * Math.pow(2, zoom),
  )
  return { x, y }
}

function tileTopLeft(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const n    = Math.pow(2, zoom)
  const lng  = (x / n) * 360 - 180
  const latR = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lat: (latR * 180) / Math.PI, lng }
}

function distToZoom(distM: number): number {
  if (distM < 500)     return 16   // immediate — ~2.4 m/px, 20ft contours
  if (distM < 1_000)   return 15   // immediate outer / ultra-near — ~4.8 m/px
  if (distM < 4_500)   return 14   // ultra-near outer — ~9.5 m/px
  if (distM < 10_500)  return 13   // near — ~19 m/px
  if (distM < 31_000)  return 11   // mid-near — ~76 m/px
  if (distM < 81_000)  return 10   // mid — ~152 m/px
  if (distM < 152_000) return 9    // mid-far — ~305 m/px
  return 8                         // far — ~610 m/px
}

function sampleTileGrid(
  grid: Float32Array, lat: number, lng: number,
  zoom: number, tx: number, ty: number,
): number {
  const nw = tileTopLeft(tx, ty, zoom)
  const se = tileTopLeft(tx + 1, ty + 1, zoom)
  const nx = (lng - nw.lng) / (se.lng - nw.lng)
  const ny = (nw.lat - lat) / (nw.lat - se.lat)
  const sx = Math.max(0, Math.min(TILE_PX - 1, nx * (TILE_PX - 1)))
  const sy = Math.max(0, Math.min(TILE_PX - 1, ny * (TILE_PX - 1)))
  const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, TILE_PX - 1)
  const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, TILE_PX - 1)
  const fx = sx - x0, fy = sy - y0
  return (
    grid[y0 * TILE_PX + x0] * (1 - fx) * (1 - fy) +
    grid[y0 * TILE_PX + x1] * fx       * (1 - fy) +
    grid[y1 * TILE_PX + x0] * (1 - fx) * fy +
    grid[y1 * TILE_PX + x1] * fx       * fy
  )
}

function sampleMeshGrid(
  lat: number, lng: number,
  elevations: Float32Array, w: number, h: number,
  bounds: { north: number; south: number; east: number; west: number },
): number {
  const nx = (lng - bounds.west)  / (bounds.east  - bounds.west)
  const ny = (bounds.north - lat) / (bounds.north - bounds.south)
  const sx = Math.max(0, Math.min(w - 1, nx * (w - 1)))
  const sy = Math.max(0, Math.min(h - 1, ny * (h - 1)))
  const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, w - 1)
  const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, h - 1)
  const fx = sx - x0, fy = sy - y0
  return (
    elevations[y0 * w + x0] * (1 - fx) * (1 - fy) +
    elevations[y0 * w + x1] * fx       * (1 - fy) +
    elevations[y1 * w + x0] * (1 - fx) * fy +
    elevations[y1 * w + x1] * fx       * fy
  )
}

/** Best-available elevation: tile cache first, mesh grid fallback. */
function sampleBest(
  lat: number, lng: number, zoom: number,
  mesh: Float32Array, mw: number, mh: number,
  bounds: { north: number; south: number; east: number; west: number },
): number {
  const { x: tx, y: ty } = latLngToTileXY(lat, lng, zoom)
  const grid = tileCacheW.get(`${zoom}/${tx}/${ty}`)
  if (grid) return sampleTileGrid(grid, lat, lng, zoom, tx, ty)
  return sampleMeshGrid(lat, lng, mesh, mw, mh, bounds)
}

/** Hill shade at a terrain point (NW-45° light). */
function hillShade(
  lat: number, lng: number, zoom: number,
  mesh: Float32Array, mw: number, mh: number,
  bounds: { north: number; south: number; east: number; west: number },
): number {
  const STEP   = zoom >= 11 ? 0.0005 : 0.002
  const cosLat = Math.cos(lat * DEG_TO_RAD)
  const dx_m   = STEP * 111_320 * cosLat
  const dy_m   = STEP * 111_132

  const eE = sampleBest(lat,        lng + STEP, zoom, mesh, mw, mh, bounds)
  const eW = sampleBest(lat,        lng - STEP, zoom, mesh, mw, mh, bounds)
  const eN = sampleBest(lat + STEP, lng,        zoom, mesh, mw, mh, bounds)
  const eS = sampleBest(lat - STEP, lng,        zoom, mesh, mw, mh, bounds)

  const dzdx = (eE - eW) / (2 * dx_m)
  const dzdy = (eN - eS) / (2 * dy_m)
  const nx = -dzdx, ny = 1.0, nz = -dzdy
  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz)
  return Math.max(0, (nx * LIGHT_X + ny * LIGHT_Y + nz * LIGHT_Z) / mag)
}

// ─── Contour Crossing Detection ──────────────────────────────────────────────

/**
 * Detect elevation crossings between two consecutive ray steps.
 * Pushes 5 floats per crossing: [elevation_m, distance_m, lat, lng, direction].
 * direction: +1.0 = terrain rising outward (up-crossing),
 *            -1.0 = terrain falling outward (down-crossing).
 * prevElev/prevDist are the FARTHER sample (march is far-to-near).
 */
function detectCrossings(
  prevElev: number, prevDist: number, prevLat: number, prevLng: number,
  currElev: number, currDist: number, currLat: number, currLng: number,
  interval: number,
  crossings: number[],  // output: push [elev, dist, lat, lng, dir] tuples
): void {
  if (prevElev === -Infinity || currElev === -Infinity) return

  const dElev = currElev - prevElev
  if (Math.abs(dElev) < 0.01) return  // Flat — no crossings

  // Direction: prev is farther, curr is nearer.
  // Going outward (curr→prev): if prevElev > currElev terrain rises → up-crossing
  const dir = prevElev > currElev ? 1.0 : -1.0

  const loElev = Math.min(prevElev, currElev)
  const hiElev = Math.max(prevElev, currElev)

  const firstLevel = Math.ceil(loElev / interval) * interval
  if (firstLevel > hiElev) return

  for (let level = firstLevel; level <= hiElev; level += interval) {
    const t = (level - prevElev) / dElev
    if (t < 0 || t > 1) continue

    const cDist = prevDist + t * (currDist - prevDist)
    const cLat  = prevLat  + t * (currLat  - prevLat)
    const cLng  = prevLng  + t * (currLng  - prevLng)

    crossings.push(level, cDist, cLat, cLng, dir)
  }
}

// ─── Worker Message Handler ───────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<SkylineRequest>) => {
  const {
    viewerLat, viewerLng, viewerElev,
    meshElevations, meshWidth, meshHeight, meshBounds,
    resolution, maxRange,
  } = e.data

  const cosViewerLat = Math.cos(viewerLat * DEG_TO_RAD)
  const numAzimuths  = Math.round(360 * resolution)

  // ── Phase 1: Prefetch tiles ───────────────────────────────────────────────

  self.postMessage({ type: 'progress', phase: 'tiles', progress: 0 })

  const zoomBands: Array<{ zoom: number; radiusM: number }> = [
    { zoom: 16, radiusM: 500 },
    { zoom: 15, radiusM: 1_000 },
    { zoom: 14, radiusM: 4_500 },
    { zoom: 13, radiusM: 10_500 },
    { zoom: 11, radiusM: 31_000 },
    { zoom:  9, radiusM: 152_000 },
    { zoom:  8, radiusM: maxRange },
  ]

  for (const { zoom, radiusM } of zoomBands) {
    const dLat = (radiusM / 111_132) * 1.1
    const dLng = (radiusM / (111_320 * cosViewerLat)) * 1.1
    const sw   = latLngToTileXY(viewerLat - dLat, viewerLng - dLng, zoom)
    const ne   = latLngToTileXY(viewerLat + dLat, viewerLng + dLng, zoom)
    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x)
    const minY = Math.min(sw.y, ne.y), maxY = Math.max(sw.y, ne.y)
    const batch: Promise<Float32Array | null>[] = []
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        batch.push(fetchWorkerTile(zoom, x, y))
      }
    }
    await Promise.all(batch)
  }

  self.postMessage({ type: 'progress', phase: 'tiles', progress: 1, tilesLoaded: tileCacheW.size })

  // ── Fix elevation source mismatch ─────────────────────────────────────────
  // Use z16 (highest-res tile at viewer location, ~2.4m resolution) for ground
  // truth. Coarser tiles average steep valleys and place the viewer underground.
  const meshGround = sampleMeshGrid(viewerLat, viewerLng, meshElevations, meshWidth, meshHeight, meshBounds)
  const tileGround = sampleBest(viewerLat, viewerLng, 16, meshElevations, meshWidth, meshHeight, meshBounds)
  const elevCorrection = tileGround - meshGround
  const correctedViewerElev = viewerElev + elevCorrection

  // ── Phase 2: Build log-step distance arrays ─────────────────────────────────

  // Full-range log steps for the standard pass
  const logDists: number[] = []
  let d = 500
  while (d <= maxRange) {
    logDists.push(d)
    d *= 1.015
  }
  logDists.reverse()  // far → near so nearer terrain wins

  // Short-range log steps for the high-res near pass (extends to 31km for mid-near band)
  // Starts at 500m — immediate band owns 0–1km with its own dedicated pass
  const HIRES_MAX_DIST = 31_000
  const hiresLogDists: number[] = []
  let d2 = 500
  while (d2 <= HIRES_MAX_DIST) {
    hiresLogDists.push(d2)
    d2 *= 1.01  // Finer distance steps for near bands
  }
  hiresLogDists.reverse()

  // Immediate band log steps: 10m → 1km at 1.005× step (very fine for ground detail)
  // Uses 720 azimuths (2 steps/°) — matches z16 tile resolution at close range
  const IMMEDIATE_MAX_DIST = 1_000
  const immediateLogDists: number[] = []
  let d3 = 10
  while (d3 <= IMMEDIATE_MAX_DIST) {
    immediateLogDists.push(d3)
    d3 *= 1.005
  }
  immediateLogDists.reverse()
  const IMMEDIATE_RESOLUTION = 2   // 0.5° per step, 720 azimuths
  const IMMEDIATE_AZIMUTHS = Math.round(360 * IMMEDIATE_RESOLUTION)

  // Determine which bands are high-res vs standard vs immediate
  const HIRES_RESOLUTION = 8  // 0.125° per step
  const hiresNumAzimuths = Math.round(360 * HIRES_RESOLUTION)
  const IMMEDIATE_BAND_IDX = 0  // Band 0 is always the immediate band
  const standardBandIndices: number[] = []
  const hiresBandIndices: number[] = []
  for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
    if (bi === IMMEDIATE_BAND_IDX) continue  // Immediate band has its own dedicated pass
    if (DEPTH_BANDS[bi].resolution && DEPTH_BANDS[bi].resolution! > resolution) {
      hiresBandIndices.push(bi)
    } else {
      standardBandIndices.push(bi)
    }
  }

  // ── Phase 3: Compute 360° skyline — standard resolution pass ──────────────

  const angles    = new Float32Array(numAzimuths)
  const distances = new Float32Array(numAzimuths)
  const shading   = new Float32Array(numAzimuths)

  // Allocate per-band arrays with per-band resolution
  const bands: SkylineBand[] = DEPTH_BANDS.map((cfg) => {
    const bandRes = cfg.resolution || resolution
    const bandAz  = Math.round(360 * bandRes)
    return {
      elevations:      new Float32Array(bandAz).fill(-Infinity),
      distances:       new Float32Array(bandAz),
      ridgeLats:       new Float32Array(bandAz),
      ridgeLngs:       new Float32Array(bandAz),
      crossingData:    new Float32Array(0),  // Will be packed after march
      crossingOffsets: new Uint32Array(bandAz + 1),
      resolution:      bandRes,
      numAzimuths:     bandAz,
    }
  })

  // Temp storage for crossings: per-band, per-azimuth
  // bandCrossingsTemp[bi][ai] = [elev, dist, lat, lng, elev, dist, lat, lng, ...]
  const bandCrossingsTemp: number[][][] = DEPTH_BANDS.map((cfg) => {
    const bandAz = Math.round(360 * (cfg.resolution || resolution))
    return Array.from({ length: bandAz }, () => [])
  })

  // Pass 1: Standard resolution (720 azimuths) — populates overall skyline + standard bands
  for (let ai = 0; ai < numAzimuths; ai++) {
    const azDeg  = ai / resolution
    const azRad  = azDeg * DEG_TO_RAD
    const sinA   = Math.sin(azRad)
    const cosA   = Math.cos(azRad)

    let maxAngle  = -Math.PI / 2
    let ridgeDist = maxRange / 2
    let ridgeLat  = viewerLat
    let ridgeLng  = viewerLng

    // Per-standard-band tracking
    const bandMaxAngles: number[] = []
    const bandRidgeDist: number[] = []
    const bandRidgeLat:  number[] = []
    const bandRidgeLng:  number[] = []
    const bandRidgeElev: number[] = []
    for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
      bandMaxAngles[bi] = -Math.PI / 2
      bandRidgeDist[bi] = 0
      bandRidgeLat[bi]  = viewerLat
      bandRidgeLng[bi]  = viewerLng
      bandRidgeElev[bi] = -Infinity
    }

    // Per-band previous-step tracking for crossing detection
    const bandPrevElev: number[] = new Array(DEPTH_BANDS.length).fill(-Infinity)
    const bandPrevDist: number[] = new Array(DEPTH_BANDS.length).fill(0)
    const bandPrevLat:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLat)
    const bandPrevLng:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLng)

    for (const dist of logDists) {
      const sLat = viewerLat + (cosA * dist) / 111_132
      const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

      const zoom    = distToZoom(dist)
      const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)

      const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev   = rawElev - curvDrop
      const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

      if (elevAngle > Math.PI / 3) continue

      // Overall maximum
      if (elevAngle > maxAngle) {
        maxAngle  = elevAngle
        ridgeDist = dist
        ridgeLat  = sLat
        ridgeLng  = sLng
      }

      // Per-band: ridgeline tracking + crossing detection (standard-res bands only)
      for (const bi of standardBandIndices) {
        const band = DEPTH_BANDS[bi]
        if (dist < band.minDist || dist > band.maxDist) continue

        // Ridgeline: track maximum elevation angle
        if (elevAngle > bandMaxAngles[bi]) {
          bandMaxAngles[bi] = elevAngle
          bandRidgeDist[bi] = dist
          bandRidgeLat[bi]  = sLat
          bandRidgeLng[bi]  = sLng
          bandRidgeElev[bi] = rawElev
        }

        // Crossing detection — uses raw (uncorrected) elevation for contour levels
        const interval = CONTOUR_INTERVALS_M[bi] || 152.4
        if (bandPrevElev[bi] !== -Infinity) {
          detectCrossings(
            bandPrevElev[bi], bandPrevDist[bi], bandPrevLat[bi], bandPrevLng[bi],
            rawElev, dist, sLat, sLng,
            interval,
            bandCrossingsTemp[bi][ai],
          )
        }
        bandPrevElev[bi] = rawElev
        bandPrevDist[bi] = dist
        bandPrevLat[bi]  = sLat
        bandPrevLng[bi]  = sLng
      }
    }

    // Overall ridgeline shade
    const ridgeZoom = distToZoom(ridgeDist)
    const shade = hillShade(ridgeLat, ridgeLng, ridgeZoom, meshElevations, meshWidth, meshHeight, meshBounds)

    angles[ai]    = maxAngle
    distances[ai] = ridgeDist
    shading[ai]   = shade

    // Populate standard-res band arrays (ridgeline only — crossings packed later)
    for (const bi of standardBandIndices) {
      bands[bi].elevations[ai] = bandRidgeElev[bi]
      bands[bi].distances[ai]  = bandRidgeDist[bi]
      bands[bi].ridgeLats[ai]  = bandRidgeLat[bi]
      bands[bi].ridgeLngs[ai]  = bandRidgeLng[bi]
    }

    if (ai % 45 === 0) {
      self.postMessage({ type: 'progress', phase: 'skyline', progress: ai / numAzimuths * 0.7 })
    }
  }

  // ── Phase 4: High-res pass (2880 azimuths, 0–31km) for near bands ────────

  if (hiresBandIndices.length > 0) {
    for (let ai = 0; ai < hiresNumAzimuths; ai++) {
      const azDeg = ai / HIRES_RESOLUTION
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      // Per high-res band tracking
      const bandMaxAngles: number[] = []
      const bandRidgeDist: number[] = []
      const bandRidgeLat:  number[] = []
      const bandRidgeLng:  number[] = []
      const bandRidgeElev: number[] = []
      for (const bi of hiresBandIndices) {
        bandMaxAngles[bi] = -Math.PI / 2
        bandRidgeDist[bi] = 0
        bandRidgeLat[bi]  = viewerLat
        bandRidgeLng[bi]  = viewerLng
        bandRidgeElev[bi] = -Infinity
      }

      // Per-band previous-step tracking for crossing detection
      const bandPrevElev: number[] = new Array(DEPTH_BANDS.length).fill(-Infinity)
      const bandPrevDist: number[] = new Array(DEPTH_BANDS.length).fill(0)
      const bandPrevLat:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLat)
      const bandPrevLng:  number[] = new Array(DEPTH_BANDS.length).fill(viewerLng)

      for (const dist of hiresLogDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

        const zoom    = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)

        const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev   = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        for (const bi of hiresBandIndices) {
          const band = DEPTH_BANDS[bi]
          if (dist < band.minDist || dist > band.maxDist) continue

          // Ridgeline: track maximum elevation angle
          if (elevAngle > bandMaxAngles[bi]) {
            bandMaxAngles[bi] = elevAngle
            bandRidgeDist[bi] = dist
            bandRidgeLat[bi]  = sLat
            bandRidgeLng[bi]  = sLng
            bandRidgeElev[bi] = rawElev
          }

          // Crossing detection
          const interval = CONTOUR_INTERVALS_M[bi] || 60.96
          if (bandPrevElev[bi] !== -Infinity) {
            detectCrossings(
              bandPrevElev[bi], bandPrevDist[bi], bandPrevLat[bi], bandPrevLng[bi],
              rawElev, dist, sLat, sLng,
              interval,
              bandCrossingsTemp[bi][ai],
            )
          }
          bandPrevElev[bi] = rawElev
          bandPrevDist[bi] = dist
          bandPrevLat[bi]  = sLat
          bandPrevLng[bi]  = sLng
        }
      }

      // Populate high-res band arrays (ridgeline only)
      for (const bi of hiresBandIndices) {
        bands[bi].elevations[ai] = bandRidgeElev[bi]
        bands[bi].distances[ai]  = bandRidgeDist[bi]
        bands[bi].ridgeLats[ai]  = bandRidgeLat[bi]
        bands[bi].ridgeLngs[ai]  = bandRidgeLng[bi]
      }

      if (ai % 90 === 0) {
        self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.7 + (ai / hiresNumAzimuths) * 0.2 })
      }
    }
  }

  // ── Phase 4a: Immediate pass (720 azimuths, 10m–1km) ────────────────────
  // Dedicated pass for the immediate band (index 0). Covers 10m–1km with
  // very fine 1.005× log steps at 720 azimuths (0.5°/step).
  // This is the sole writer for band 0 — standard/hires passes skip it.

  if (immediateLogDists.length > 0) {
    const immBand = bands[IMMEDIATE_BAND_IDX]

    for (let ai = 0; ai < IMMEDIATE_AZIMUTHS; ai++) {
      const azDeg = ai / IMMEDIATE_RESOLUTION
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      let bestAngle = -Math.PI / 2
      let bestDist  = 0
      let bestLat   = viewerLat
      let bestLng   = viewerLng
      let bestElev  = -Infinity as number

      // Previous-step tracking for crossing detection
      let prevElev = -Infinity as number
      let prevDist = 0
      let prevLat  = viewerLat
      let prevLng  = viewerLng

      for (const dist of immediateLogDists) {
        const band = DEPTH_BANDS[IMMEDIATE_BAND_IDX]
        if (dist < band.minDist || dist > band.maxDist) continue

        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

        const zoom    = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)

        const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev   = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        // Ridgeline: track maximum elevation angle
        if (elevAngle > bestAngle) {
          bestAngle = elevAngle
          bestDist  = dist
          bestLat   = sLat
          bestLng   = sLng
          bestElev  = rawElev
        }

        // Crossing detection for immediate band
        const interval = CONTOUR_INTERVALS_M[IMMEDIATE_BAND_IDX] || 6.096
        if (prevElev !== -Infinity) {
          detectCrossings(
            prevElev, prevDist, prevLat, prevLng,
            rawElev, dist, sLat, sLng,
            interval,
            bandCrossingsTemp[IMMEDIATE_BAND_IDX][ai],
          )
        }
        prevElev = rawElev
        prevDist = dist
        prevLat  = sLat
        prevLng  = sLng
      }

      // Update overall skyline if immediate terrain is the highest at this azimuth
      // Map immediate azimuth to standard azimuth index
      const overallAi = Math.round((ai / IMMEDIATE_RESOLUTION) * resolution) % numAzimuths
      if (bestElev > -Infinity && bestAngle > angles[overallAi]) {
        angles[overallAi]    = bestAngle
        distances[overallAi] = bestDist
        // Update shading for the immediate ridgeline point
        const ridgeZoom = distToZoom(bestDist)
        shading[overallAi] = hillShade(bestLat, bestLng, ridgeZoom, meshElevations, meshWidth, meshHeight, meshBounds)
      }

      // Populate immediate band arrays
      immBand.elevations[ai] = bestElev
      immBand.distances[ai]  = bestDist
      immBand.ridgeLats[ai]  = bestLat
      immBand.ridgeLngs[ai]  = bestLng
    }

    self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.95 })
  }

  // ── Phase 5: Pack crossing data into flat arrays ──────────────────────────

  for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
    const azCrossings = bandCrossingsTemp[bi]
    const bandAz = bands[bi].numAzimuths
    const offsets = new Uint32Array(bandAz + 1)

    // Count total crossings (each crossing = 4 floats)
    let totalFloats = 0
    for (let ai = 0; ai < bandAz; ai++) {
      offsets[ai] = totalFloats
      totalFloats += azCrossings[ai].length  // Already in groups of 4
    }
    offsets[bandAz] = totalFloats

    // Pack into flat Float32Array
    const data = new Float32Array(totalFloats)
    let idx = 0
    for (let ai = 0; ai < bandAz; ai++) {
      const c = azCrossings[ai]
      for (let j = 0; j < c.length; j++) {
        data[idx++] = c[j]
      }
    }

    bands[bi].crossingData = data
    bands[bi].crossingOffsets = offsets
  }

  const skyline: SkylineData = {
    angles,
    distances,
    shading,
    bands,
    resolution,
    numAzimuths,
    computedAt: {
      lat:       viewerLat,
      lng:       viewerLng,
      elev:      correctedViewerElev,
      groundElev: tileGround,
      timestamp: Date.now(),
    },
  }

  // Transfer ArrayBuffers (zero-copy) — include band buffers
  const transferables: Transferable[] = [
    angles.buffer as ArrayBuffer,
    distances.buffer as ArrayBuffer,
    shading.buffer as ArrayBuffer,
  ]
  for (const band of bands) {
    transferables.push(
      band.elevations.buffer as ArrayBuffer,
      band.distances.buffer as ArrayBuffer,
      band.ridgeLats.buffer as ArrayBuffer,
      band.ridgeLngs.buffer as ArrayBuffer,
      band.crossingData.buffer as ArrayBuffer,
      band.crossingOffsets.buffer as ArrayBuffer,
    )
  }
  self.postMessage({ type: 'complete', skyline }, transferables)
}
