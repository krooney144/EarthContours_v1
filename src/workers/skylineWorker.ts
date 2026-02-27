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
 *    Fetch AWS Terrarium tiles for z13 (0–5 km), z11 (5–20 km), z8 (far) in parallel.
 *    Uses createImageBitmap + OffscreenCanvas for PNG decoding (worker-safe).
 *
 *  Phase 2 — Skyline computation:
 *    For each of 720 azimuth steps (0.5°/step = full 360°):
 *      Walk outward with logarithmic steps (100 m → maxRange).
 *      For each step:
 *        Sample elevation from tile cache; fall back to mesh grid.
 *        Apply Earth curvature + atmospheric refraction correction.
 *        Track maximum elevation angle seen (= ridgeline for this direction).
 *      Compute hill shade at the final ridgeline point.
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
  { label: 'near',     minDist: 0,       maxDist: 8_000,   resolution: 4 },  // 0–8 km   (0.25°)
  { label: 'med-near', minDist: 7_000,   maxDist: 20_000,  resolution: 4 },  // 7–20 km  (0.25°)
  { label: 'mid',      minDist: 19_000,  maxDist: 50_000  },                  // 19–50 km (0.5°)
  { label: 'med-far',  minDist: 48_000,  maxDist: 120_000 },                  // 48–120 km
  { label: 'far',      minDist: 115_000, maxDist: 400_000 },                  // 115–400 km
]

interface SkylineBand {
  elevations:  Float32Array
  distances:   Float32Array
  slopeX:      Float32Array
  slopeZ:      Float32Array
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
  if (distM < 5_000)   return 13
  if (distM < 20_000)  return 11
  if (distM < 80_000)  return 10
  if (distM < 150_000) return 9
  return 8
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

/** Finite-difference slope + hill shade at a terrain point.
 *  Returns { shade, dzdx, dzdy } — slope vectors preserved for contour fragments. */
function slopeAndShade(
  lat: number, lng: number, zoom: number,
  mesh: Float32Array, mw: number, mh: number,
  bounds: { north: number; south: number; east: number; west: number },
): { shade: number; dzdx: number; dzdy: number } {
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
  const shade = Math.max(0, (nx * LIGHT_X + ny * LIGHT_Y + nz * LIGHT_Z) / mag)
  return { shade, dzdx, dzdy }
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
    { zoom: 13, radiusM: 5_000 },
    { zoom: 11, radiusM: 20_000 },
    { zoom:  9, radiusM: 150_000 },
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
  // The main thread computes viewerElev from the coarse region mesh (~860m/px).
  // The worker samples nearby terrain from z13 tiles (~19m/px). In mountain
  // valleys the mesh smooths the canyon to ~1535m while tiles show ~3000m nearby,
  // creating 86° "cliff" angles at 100m. Re-sample the viewer's ground from
  // the same tile source so both sides agree.
  const meshGround = sampleMeshGrid(viewerLat, viewerLng, meshElevations, meshWidth, meshHeight, meshBounds)
  const tileGround = sampleBest(viewerLat, viewerLng, 13, meshElevations, meshWidth, meshHeight, meshBounds)
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

  // Short-range log steps for the high-res near pass (only to 20km)
  const HIRES_MAX_DIST = 20_000
  const hiresLogDists: number[] = []
  let d2 = 200  // Start closer for near detail
  while (d2 <= HIRES_MAX_DIST) {
    hiresLogDists.push(d2)
    d2 *= 1.01  // Finer distance steps for near bands
  }
  hiresLogDists.reverse()

  // Determine which bands are high-res vs standard
  const HIRES_RESOLUTION = 4  // 0.25° per step
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
      elevations:  new Float32Array(bandAz).fill(-Infinity),
      distances:   new Float32Array(bandAz),
      slopeX:      new Float32Array(bandAz),
      slopeZ:      new Float32Array(bandAz),
      resolution:  bandRes,
      numAzimuths: bandAz,
    }
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

      // Only populate standard-res bands in this pass
      for (const bi of standardBandIndices) {
        const band = DEPTH_BANDS[bi]
        if (dist >= band.minDist && dist <= band.maxDist && elevAngle > bandMaxAngles[bi]) {
          bandMaxAngles[bi] = elevAngle
          bandRidgeDist[bi] = dist
          bandRidgeLat[bi]  = sLat
          bandRidgeLng[bi]  = sLng
          bandRidgeElev[bi] = rawElev
        }
      }
    }

    // Overall ridgeline shade
    const ridgeZoom = distToZoom(ridgeDist)
    const { shade } = slopeAndShade(ridgeLat, ridgeLng, ridgeZoom, meshElevations, meshWidth, meshHeight, meshBounds)

    angles[ai]    = maxAngle
    distances[ai] = ridgeDist
    shading[ai]   = shade

    // Populate standard-res band arrays
    for (const bi of standardBandIndices) {
      bands[bi].elevations[ai] = bandRidgeElev[bi]
      bands[bi].distances[ai]  = bandRidgeDist[bi]

      if (bandRidgeElev[bi] > -Infinity && bandRidgeDist[bi] > 0) {
        const bZoom = distToZoom(bandRidgeDist[bi])
        const { dzdx, dzdy } = slopeAndShade(
          bandRidgeLat[bi], bandRidgeLng[bi], bZoom,
          meshElevations, meshWidth, meshHeight, meshBounds,
        )
        bands[bi].slopeX[ai] = dzdx
        bands[bi].slopeZ[ai] = dzdy
      }
    }

    if (ai % 45 === 0) {
      self.postMessage({ type: 'progress', phase: 'skyline', progress: ai / numAzimuths * 0.7 })
    }
  }

  // ── Phase 4: High-res pass (1440 azimuths, 0–20km) for near bands ────────

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
          if (dist >= band.minDist && dist <= band.maxDist && elevAngle > bandMaxAngles[bi]) {
            bandMaxAngles[bi] = elevAngle
            bandRidgeDist[bi] = dist
            bandRidgeLat[bi]  = sLat
            bandRidgeLng[bi]  = sLng
            bandRidgeElev[bi] = rawElev
          }
        }
      }

      // Populate high-res band arrays
      for (const bi of hiresBandIndices) {
        bands[bi].elevations[ai] = bandRidgeElev[bi]
        bands[bi].distances[ai]  = bandRidgeDist[bi]

        if (bandRidgeElev[bi] > -Infinity && bandRidgeDist[bi] > 0) {
          const bZoom = distToZoom(bandRidgeDist[bi])
          const { dzdx, dzdy } = slopeAndShade(
            bandRidgeLat[bi], bandRidgeLng[bi], bZoom,
            meshElevations, meshWidth, meshHeight, meshBounds,
          )
          bands[bi].slopeX[ai] = dzdx
          bands[bi].slopeZ[ai] = dzdy
        }
      }

      if (ai % 90 === 0) {
        self.postMessage({ type: 'progress', phase: 'skyline', progress: 0.7 + (ai / hiresNumAzimuths) * 0.3 })
      }
    }
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
      band.slopeX.buffer as ArrayBuffer,
      band.slopeZ.buffer as ArrayBuffer,
    )
  }
  self.postMessage({ type: 'complete', skyline }, transferables)
}
