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
 *    Standard pass (500m→400km @ 1.015×), hi-res pass (200m→31km @ 1.01×),
 *    ultra-near pass (20m→200m @ 1.005× at 360 azimuths).
 *
 *  Phase 3 — Standard resolution skyline (1440 azimuths, full range)
 *  Phase 4 — High-res pass (2880 azimuths, 0–31km for bands with resolution=8)
 *  Phase 4b — Ultra-near pass (360 azimuths, 20–200m for ultra-near band)
 *  Phase 5 — Pack crossing data into flat transferable arrays
 *
 *  Contour intervals: 50ft (ultra-near) → 100ft → 200ft → 500ft → 1000ft → 2000ft (far)
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
 *  ultra-near = 50ft, near = 100ft, mid-near = 200ft,
 *  mid = 500ft, mid-far = 1000ft, far = 2000ft. */
const CONTOUR_INTERVALS_M: number[] = [
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
  { label: 'ultra-near', minDist: 0,       maxDist: 4_500,   resolution: 8 },  // 0–4.5 km   (0.125°, 2880 az)
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

/** Refined arc: dense ray-march data around a detected ridgeline feature. */
interface RefinedArc {
  centerBearing: number
  halfWidth:     number
  numSamples:    number
  stepDeg:       number
  elevations:    Float32Array
  distances:     Float32Array
  ridgeLats:     Float32Array
  ridgeLngs:     Float32Array
  bandIndex:     number
  featureDist:   number
  featureElev:   number
  featureBearing: number
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
  /** Refined arcs — dense ray-march data around detected ridgeline features */
  refinedArcs: RefinedArc[]
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
  if (distM < 1_000)   return 15   // ultra-near detail — ~4.8 m/px, 50ft contours
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
  // Use z15 (highest-res tile at viewer location, ~10m resolution) for ground
  // truth. z13 (~40m) was averaging steep valleys and placing the viewer underground.
  const meshGround = sampleMeshGrid(viewerLat, viewerLng, meshElevations, meshWidth, meshHeight, meshBounds)
  const tileGround = sampleBest(viewerLat, viewerLng, 15, meshElevations, meshWidth, meshHeight, meshBounds)
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
  const HIRES_MAX_DIST = 31_000
  const hiresLogDists: number[] = []
  let d2 = 200  // Start closer for near detail
  while (d2 <= HIRES_MAX_DIST) {
    hiresLogDists.push(d2)
    d2 *= 1.01  // Finer distance steps for near bands
  }
  hiresLogDists.reverse()

  // Ultra-near log steps: 20m → 200m at 1.005× step (very fine for cliff faces)
  // Uses 360 azimuths (1° per step) — sufficient for close terrain
  const ULTRA_NEAR_MAX_DIST = 200
  const ultraNearLogDists: number[] = []
  let d3 = 20
  while (d3 <= ULTRA_NEAR_MAX_DIST) {
    ultraNearLogDists.push(d3)
    d3 *= 1.005
  }
  ultraNearLogDists.reverse()
  const ULTRA_NEAR_AZIMUTHS = 360  // 1° per step for 20–200m range

  // Determine which bands are high-res vs standard
  const HIRES_RESOLUTION = 8  // 0.125° per step
  const hiresNumAzimuths = Math.round(360 * HIRES_RESOLUTION)
  const standardBandIndices: number[] = []
  const hiresBandIndices: number[] = []
  for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
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

  // ── Phase 4b: Ultra-near pass (360 azimuths, 20–200m) ─────────────────────
  // Fills the ultra-near band (index 0) with close-range terrain that the
  // hi-res pass (starting at 200m) would miss.  Uses coarser 1° azimuth
  // resolution since features at 20–200m subtend large angular spans.
  // Results are merged into every 8th slot of the 2880-element band arrays.

  if (ultraNearLogDists.length > 0 && DEPTH_BANDS[0].maxDist > 0) {
    const ultraBandIdx = 0  // ultra-near is always band 0
    const band = bands[ultraBandIdx]

    for (let uai = 0; uai < ULTRA_NEAR_AZIMUTHS; uai++) {
      const azDeg = uai  // 1° steps
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      // Map 360-azimuth index to 2880-element band array index (every 8th slot)
      const bandAi = uai * HIRES_RESOLUTION  // 8 hi-res steps per degree

      let bestAngle = band.elevations[bandAi] > -Infinity
        ? Math.atan2(band.elevations[bandAi] - (band.distances[bandAi] * band.distances[bandAi]) / (2 * EARTH_R) * (1 - REFRACTION_K) - correctedViewerElev, band.distances[bandAi])
        : -Math.PI / 2

      let bestDist = band.distances[bandAi]
      let bestLat  = band.ridgeLats[bandAi]
      let bestLng  = band.ridgeLngs[bandAi]
      let bestElev = band.elevations[bandAi]

      // Previous-step tracking for crossing detection
      let prevElev = -Infinity as number
      let prevDist = 0
      let prevLat  = viewerLat
      let prevLng  = viewerLng

      for (const dist of ultraNearLogDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

        const zoom    = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)

        const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev   = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        if (elevAngle > bestAngle) {
          bestAngle = elevAngle
          bestDist  = dist
          bestLat   = sLat
          bestLng   = sLng
          bestElev  = rawElev
        }

        // Crossing detection for ultra-near band
        const interval = CONTOUR_INTERVALS_M[ultraBandIdx] || 15.24
        if (prevElev !== -Infinity) {
          detectCrossings(
            prevElev, prevDist, prevLat, prevLng,
            rawElev, dist, sLat, sLng,
            interval,
            bandCrossingsTemp[ultraBandIdx][bandAi],
          )
        }
        prevElev = rawElev
        prevDist = dist
        prevLat  = sLat
        prevLng  = sLng
      }

      // Only update if ultra-near pass found a higher ridgeline than hi-res pass
      if (bestElev > -Infinity && bestAngle > (band.elevations[bandAi] > -Infinity
        ? Math.atan2(band.elevations[bandAi] - (band.distances[bandAi] * band.distances[bandAi]) / (2 * EARTH_R) * (1 - REFRACTION_K) - correctedViewerElev, band.distances[bandAi])
        : -Math.PI / 2)) {
        band.elevations[bandAi] = bestElev
        band.distances[bandAi]  = bestDist
        band.ridgeLats[bandAi]  = bestLat
        band.ridgeLngs[bandAi]  = bestLng
      }
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

  // ── Phase 6: Refined arcs — dense ray-march around prominent features ─────
  //
  // Scan each band's ridgeline for prominent local maxima (peaks that stand
  // out above their surroundings).  For each detected feature, do a dense
  // ray march at ~0.05° azimuth steps (5× finer than hi-res bands) covering
  // ±6° around the feature.  Stores raw elevation/distance/GPS per sample
  // for AGL re-projection.  Capped at 20 features to bound compute time.
  //
  // Feature detection: a local maximum in band elevation angle that is ≥0.3°
  // above the average of its ±5° neighbors, with at least 2° separation
  // between detected features.

  const REFINED_STEP_DEG   = 0.05   // ~20 samples/degree
  const REFINED_HALF_DEG   = 6      // ±6° arc = 12° total = ~240 samples
  const MAX_ARCS           = 20
  const FEATURE_MIN_PROMINENCE_RAD = 0.3 * DEG_TO_RAD  // Minimum 0.3° above neighbors
  const FEATURE_MIN_SEPARATION_DEG = 2    // Minimum 2° between detected features

  const refinedArcs: RefinedArc[] = []

  // Detect prominent features across all bands
  interface DetectedFeature {
    bandIndex:      number
    azimuthIdx:     number
    bearing:        number
    angle:          number   // elevation angle at this azimuth
    neighborAvg:    number   // average angle of ±5° neighbors
    prominence:     number   // angle - neighborAvg
    dist:           number   // distance to ridge
    elev:           number   // raw elevation
  }

  const detectedFeatures: DetectedFeature[] = []

  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const neighborSpan = Math.round(5 * bandRes)  // ±5° in azimuth samples

    for (let ai = 0; ai < bandAz; ai++) {
      if (band.elevations[ai] === -Infinity) continue

      const dist = band.distances[ai]
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const angle = Math.atan2(band.elevations[ai] - curvDrop - correctedViewerElev, dist)

      // Check if this is a local maximum — higher than all immediate neighbors (±1 sample)
      let isLocalMax = true
      for (let offset = -1; offset <= 1; offset += 2) {
        const ni = (ai + offset + bandAz) % bandAz
        if (band.elevations[ni] === -Infinity) continue
        const nDist = band.distances[ni]
        const nCurv = (nDist * nDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const nAngle = Math.atan2(band.elevations[ni] - nCurv - correctedViewerElev, nDist)
        if (nAngle >= angle) { isLocalMax = false; break }
      }
      if (!isLocalMax) continue

      // Compute average angle of ±5° neighbors for prominence check
      let sumAngle = 0
      let countAngle = 0
      for (let offset = -neighborSpan; offset <= neighborSpan; offset++) {
        if (offset === 0) continue
        const ni = (ai + offset + bandAz) % bandAz
        if (band.elevations[ni] === -Infinity) continue
        const nDist = band.distances[ni]
        const nCurv = (nDist * nDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        sumAngle += Math.atan2(band.elevations[ni] - nCurv - correctedViewerElev, nDist)
        countAngle++
      }

      if (countAngle < 3) continue  // Not enough neighbors for a reliable prominence check
      const neighborAvg = sumAngle / countAngle
      const prominence = angle - neighborAvg

      if (prominence < FEATURE_MIN_PROMINENCE_RAD) continue

      detectedFeatures.push({
        bandIndex: bi,
        azimuthIdx: ai,
        bearing: ai / bandRes,
        angle,
        neighborAvg,
        prominence,
        dist: band.distances[ai],
        elev: band.elevations[ai],
      })
    }
  }

  // Sort by prominence (most prominent first), enforce minimum separation, cap at MAX_ARCS
  detectedFeatures.sort((a, b) => b.prominence - a.prominence)

  const selectedFeatures: DetectedFeature[] = []
  for (const feat of detectedFeatures) {
    if (selectedFeatures.length >= MAX_ARCS) break

    // Check separation from already-selected features
    let tooClose = false
    for (const sel of selectedFeatures) {
      let dBearing = Math.abs(feat.bearing - sel.bearing)
      if (dBearing > 180) dBearing = 360 - dBearing
      if (dBearing < FEATURE_MIN_SEPARATION_DEG) { tooClose = true; break }
    }
    if (tooClose) continue

    selectedFeatures.push(feat)
  }

  // Dense ray-march around each selected feature
  for (const feat of selectedFeatures) {
    const numSamples = Math.round((REFINED_HALF_DEG * 2) / REFINED_STEP_DEG) + 1
    const elevations = new Float32Array(numSamples).fill(-Infinity)
    const dists      = new Float32Array(numSamples)
    const lats       = new Float32Array(numSamples)
    const lngs       = new Float32Array(numSamples)

    // Determine distance step array based on feature distance
    const bandCfg = DEPTH_BANDS[feat.bandIndex]
    const marchMin = bandCfg.minDist || 20
    const marchMax = bandCfg.maxDist

    // Build fine distance steps for this band's range
    const arcDists: number[] = []
    let arcD = Math.max(20, marchMin)
    const stepMul = marchMax < 5000 ? 1.005 : marchMax < 31000 ? 1.01 : 1.015
    while (arcD <= marchMax) {
      arcDists.push(arcD)
      arcD *= stepMul
    }
    arcDists.reverse()  // far → near

    for (let si = 0; si < numSamples; si++) {
      const bearingOffset = -REFINED_HALF_DEG + si * REFINED_STEP_DEG
      const azDeg = feat.bearing + bearingOffset
      const azRad = azDeg * DEG_TO_RAD
      const sinA  = Math.sin(azRad)
      const cosA  = Math.cos(azRad)

      let bestAngle = -Math.PI / 2
      let bestDist  = 0
      let bestLat   = viewerLat
      let bestLng   = viewerLng
      let bestElev  = -Infinity as number

      for (const dist of arcDists) {
        const sLat = viewerLat + (cosA * dist) / 111_132
        const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)
        const zoom = distToZoom(dist)
        const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)
        const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev  = rawElev - curvDrop
        const elevAngle = Math.atan2(effElev - correctedViewerElev, dist)

        if (elevAngle > Math.PI / 3) continue

        if (elevAngle > bestAngle) {
          bestAngle = elevAngle
          bestDist  = dist
          bestLat   = sLat
          bestLng   = sLng
          bestElev  = rawElev
        }
      }

      elevations[si] = bestElev
      dists[si]      = bestDist
      lats[si]       = bestLat
      lngs[si]       = bestLng
    }

    refinedArcs.push({
      centerBearing:  feat.bearing,
      halfWidth:      REFINED_HALF_DEG,
      numSamples,
      stepDeg:        REFINED_STEP_DEG,
      elevations,
      distances:      dists,
      ridgeLats:      lats,
      ridgeLngs:      lngs,
      bandIndex:      feat.bandIndex,
      featureDist:    feat.dist,
      featureElev:    feat.elev,
      featureBearing: feat.bearing,
    })
  }

  self.postMessage({ type: 'progress', phase: 'skyline', progress: 1.0 })

  const skyline: SkylineData = {
    angles,
    distances,
    shading,
    bands,
    refinedArcs,
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
  // Transfer refined arc buffers (zero-copy)
  for (const arc of refinedArcs) {
    transferables.push(
      arc.elevations.buffer as ArrayBuffer,
      arc.distances.buffer as ArrayBuffer,
      arc.ridgeLats.buffer as ArrayBuffer,
      arc.ridgeLngs.buffer as ArrayBuffer,
    )
  }
  self.postMessage({ type: 'complete', skyline }, transferables)
}
