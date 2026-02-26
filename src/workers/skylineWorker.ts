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

export interface SkylineData {
  /** Max elevation angle (radians) at each azimuth step */
  angles:      Float32Array
  /** Near-field max elevation angle — terrain 0–10 km */
  anglesNear:  Float32Array
  /** Mid-field max elevation angle — terrain 10–50 km */
  anglesMid:   Float32Array
  /** Far-field max elevation angle — terrain 50–250 km */
  anglesFar:   Float32Array
  /** Distance to ridgeline (metres) */
  distances:   Float32Array
  /** Hill shade at ridgeline [0–1] */
  shading:     Float32Array
  /** Steps per degree used during computation */
  resolution:  number
  /** Total azimuth steps (= 360 × resolution) */
  numAzimuths: number
  computedAt: { lat: number; lng: number; elev: number; timestamp: number }
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

/** Finite-difference hill shade at a terrain point. */
function hillShade(
  lat: number, lng: number, zoom: number,
  mesh: Float32Array, mw: number, mh: number,
  bounds: { north: number; south: number; east: number; west: number },
): number {
  // Step size: finer for high-zoom (close) terrain, coarser for far
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

  // ── Phase 2: Build log-step distance array (far→near) ─────────────────────

  const logDists: number[] = []
  let d = 100
  while (d <= maxRange) {
    logDists.push(d)
    d *= 1.015
  }
  logDists.reverse()  // far → near so nearer terrain wins

  // ── Phase 3: Compute 360° skyline ─────────────────────────────────────────

  const angles     = new Float32Array(numAzimuths)
  const anglesNear = new Float32Array(numAzimuths)
  const anglesMid  = new Float32Array(numAzimuths)
  const anglesFar  = new Float32Array(numAzimuths)
  const distances  = new Float32Array(numAzimuths)
  const shading    = new Float32Array(numAzimuths)

  // Distance band thresholds (metres)
  const NEAR_MAX =  10_000  // 0–10 km
  const MID_MAX  =  50_000  // 10–50 km
  // Far = 50 km–maxRange

  for (let ai = 0; ai < numAzimuths; ai++) {
    const azDeg  = ai / resolution
    const azRad  = azDeg * DEG_TO_RAD
    const sinA   = Math.sin(azRad)
    const cosA   = Math.cos(azRad)

    let maxAngle  = -Math.PI / 2  // start below horizon
    let maxNear   = -Math.PI / 2
    let maxMid    = -Math.PI / 2
    let maxFar    = -Math.PI / 2
    let ridgeDist = maxRange / 2
    let ridgeLat  = viewerLat
    let ridgeLng  = viewerLng

    for (const dist of logDists) {
      const sLat = viewerLat + (cosA * dist) / 111_132
      const sLng = viewerLng + (sinA * dist) / (111_320 * cosViewerLat)

      const zoom   = distToZoom(dist)
      const rawElev = sampleBest(sLat, sLng, zoom, meshElevations, meshWidth, meshHeight, meshBounds)

      // Earth curvature + atmospheric refraction correction
      const curvDrop  = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev   = rawElev - curvDrop
      const elevAngle = Math.atan2(effElev - viewerElev, dist)

      // Per-band max angle tracking
      if (dist <= NEAR_MAX) {
        if (elevAngle > maxNear) maxNear = elevAngle
      } else if (dist <= MID_MAX) {
        if (elevAngle > maxMid) maxMid = elevAngle
      } else {
        if (elevAngle > maxFar) maxFar = elevAngle
      }

      // Overall max (for ridgeline + peak visibility)
      if (elevAngle > maxAngle) {
        maxAngle  = elevAngle
        ridgeDist = dist
        ridgeLat  = sLat
        ridgeLng  = sLng
      }
    }

    // Hill shade computed once at the final ridgeline position
    const ridgeZoom = distToZoom(ridgeDist)
    const shade = hillShade(ridgeLat, ridgeLng, ridgeZoom, meshElevations, meshWidth, meshHeight, meshBounds)

    angles[ai]     = maxAngle
    anglesNear[ai] = maxNear
    anglesMid[ai]  = maxMid
    anglesFar[ai]  = maxFar
    distances[ai]  = ridgeDist
    shading[ai]    = shade

    // Progress every 45 azimuths (~12.5° increments)
    if (ai % 45 === 0) {
      self.postMessage({ type: 'progress', phase: 'skyline', progress: ai / numAzimuths })
    }
  }

  const skyline: SkylineData = {
    angles,
    anglesNear,
    anglesMid,
    anglesFar,
    distances,
    shading,
    resolution,
    numAzimuths,
    computedAt: {
      lat:       viewerLat,
      lng:       viewerLng,
      elev:      viewerElev,
      timestamp: Date.now(),
    },
  }

  // Transfer ArrayBuffers (zero-copy) to main thread
  self.postMessage(
    { type: 'complete', skyline },
    [
      angles.buffer, anglesNear.buffer, anglesMid.buffer, anglesFar.buffer,
      distances.buffer, shading.buffer,
    ],
  )
}
