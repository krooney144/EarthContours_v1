/**
 * EarthContours — MAP Screen
 *
 * Pure DEM (Digital Elevation Model) overlay — no basemap tiles.
 * Each tile is loaded as raw Terrarium RGB elevation data, decoded,
 * and re-colorized using the ocean-depth palette:
 *
 *   Sea level / below  → darkest blue-black  (#000810)
 *   Low terrain        → deep navy           (#0E3951)
 *   Mid terrain        → mid-ocean blue      (#2F6D87)
 *   High peaks         → bright teal-foam    (#84D1DB)
 *
 * The result is a topographic heat-map where brightness = altitude.
 * All overlays (GPS dot, explore marker, peak labels, region border) render
 * on top of the DEM canvas exactly as before.
 *
 * Elevation source: AWS Terrarium tiles (free, global, no API key)
 *   Tile URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   Decoding: elevation = R*256 + G + B/256 − 32768
 *
 * The `TerrainProvider` swap point (Session 2+):
 *   Replace `loadElevationTile` in the import below with any source that
 *   returns `CachedTile` — no other code changes needed.
 *
 * Controls:
 *   Drag to pan · Scroll/pinch to zoom (4–16) · Tap to set explore location
 *
 * Attribution: © Mapzen / AWS Terrain Tiles · © OpenStreetMap contributors
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import {
  DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM,
  MAP_MIN_ZOOM, MAP_MAX_ZOOM, TILE_SIZE,
  MAP_LABEL_TILE_URL, MAP_TILE_SUBDOMAINS,
} from '../../core/constants'
import {
  latLngToTile, tileToLatLng, latLngToPixel, pixelToLatLng,
  clamp, formatCoordinates, formatDistance,
} from '../../core/utils'
import { loadElevationTile } from '../../data/elevationLoader'
import type { TileCoord } from '../../core/types'
import styles from './MapScreen.module.css'

const log = createLogger('SCREEN:MAP')

// ─── Attribution ───────────────────────────────────────────────────────────────

const DEM_ATTRIBUTION = '© Mapzen / AWS Terrain Tiles · © OpenStreetMap · © CARTO'

// ─── Elevation → Ocean-Depth Color ────────────────────────────────────────────

/**
 * Map an elevation (meters) to an RGB color.
 *
 * Ramp goes from "ocean black" at sea level to near-white at 16,000ft (4,877m):
 *
 *   ≤  0m → near-black ocean (#010812)
 *    100m → very dark navy  — "just 1 foot above sea level"
 *   1000m → dark navy blue
 *   2000m → medium blue
 *   3000m → lighter blue
 *   4000m → pale blue-grey
 *   4877m → near-white (16,000ft)
 *   5500m → almost white
 *
 * This is an inverted hypsometric tint in the ocean-depth color family:
 * brightness encodes altitude, dark = low, light = high.
 */
const ELEV_STOPS: Array<[number, number, number, number]> = [
  //  elev_m    R    G    B
  [  -500,     0,   4,  10],   // ocean void — near-pure black
  [     0,     1,   8,  18],   // sea level — ocean black
  [   100,     8,  24,  52],   // just above sea — very dark navy
  [   500,    16,  48,  92],   // low terrain — dark navy
  [  1000,    25,  72, 130],   // ~3,280ft — navy blue
  [  1500,    40,  97, 158],   // ~5,000ft
  [  2000,    60, 122, 175],   // ~6,560ft — medium blue
  [  2500,    82, 148, 192],   // ~8,200ft
  [  3000,   110, 172, 208],   // ~9,840ft — lighter blue
  [  3500,   142, 196, 222],   // ~11,480ft
  [  4000,   175, 218, 237],   // ~13,120ft — pale blue
  [  4500,   205, 235, 247],   // ~14,760ft — very pale blue
  [  4877,   225, 244, 252],   // 16,000ft — near white
  [  5500,   240, 250, 255],   // above 16,000ft — almost white
]

function elevationToRGB(elev: number): [number, number, number] {
  // Clamp to table range
  if (elev <= ELEV_STOPS[0][0]) {
    return [ELEV_STOPS[0][1], ELEV_STOPS[0][2], ELEV_STOPS[0][3]]
  }
  const last = ELEV_STOPS[ELEV_STOPS.length - 1]
  if (elev >= last[0]) {
    return [last[1], last[2], last[3]]
  }

  // Binary search for the enclosing pair of stops
  let lo = 0
  let hi = ELEV_STOPS.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ELEV_STOPS[mid][0] <= elev) lo = mid
    else hi = mid
  }

  const [e0, r0, g0, b0] = ELEV_STOPS[lo]
  const [e1, r1, g1, b1] = ELEV_STOPS[hi]
  const t = (elev - e0) / (e1 - e0)

  return [
    Math.round(r0 + t * (r1 - r0)),
    Math.round(g0 + t * (g1 - g0)),
    Math.round(b0 + t * (b1 - b0)),
  ]
}

// ─── DEM Tile Cache ────────────────────────────────────────────────────────────

/**
 * Cache of pre-colorized DEM tiles.
 * Key: `${z}/${x}/${y}` → `HTMLCanvasElement` with ocean-depth pixel colors.
 * These canvases are drawn directly onto the map canvas with `ctx.drawImage`.
 */
const demTileCache = new Map<string, HTMLCanvasElement>()
const DEM_TILE_CACHE_MAX = 200

/**
 * Load a DEM tile:
 *   1. Fetch raw Terrarium RGB PNG (via elevationLoader cache chain)
 *   2. Decode each pixel: elev = R*256 + G + B/256 − 32768
 *   3. Map elev → ocean-depth RGBA
 *   4. Return a 256×256 HTMLCanvasElement
 */
async function loadDEMTile(z: number, x: number, y: number): Promise<HTMLCanvasElement> {
  const key = `${z}/${x}/${y}`

  if (demTileCache.has(key)) {
    return demTileCache.get(key)!
  }

  const rawTile = await loadElevationTile(z, x, y)
  const { pixels, width, height } = rawTile

  const tileCanvas = document.createElement('canvas')
  tileCanvas.width  = width
  tileCanvas.height = height

  const ctx = tileCanvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const data = imageData.data
  const count = width * height

  for (let i = 0; i < count; i++) {
    const r = pixels[i * 4]
    const g = pixels[i * 4 + 1]
    const b = pixels[i * 4 + 2]
    const elev = r * 256 + g + b / 256 - 32768

    const [cr, cg, cb] = elevationToRGB(elev)
    data[i * 4]     = cr
    data[i * 4 + 1] = cg
    data[i * 4 + 2] = cb
    data[i * 4 + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)

  // Evict oldest entry if cache is full
  if (demTileCache.size >= DEM_TILE_CACHE_MAX) {
    const firstKey = demTileCache.keys().next().value
    if (firstKey) demTileCache.delete(firstKey)
  }
  demTileCache.set(key, tileCanvas)

  log.debug('DEM tile colorized', { key, width, height })
  return tileCanvas
}

// ─── Label Tile Cache ──────────────────────────────────────────────────────────

/**
 * Cache of Carto dark_only_labels tiles (transparent PNG, white text).
 * Drawn on top of the DEM layer to show towns, cities, and roads.
 * Key: `${z}/${x}/${y}` → `HTMLImageElement`
 */
const labelTileCache = new Map<string, HTMLImageElement>()
const LABEL_TILE_CACHE_MAX = 300

/**
 * Load a label tile from Carto's dark_only_labels endpoint.
 * These are fully transparent except for white place/road labels —
 * perfect for overlaying on top of the DEM without obscuring it.
 */
function loadLabelTile(z: number, x: number, y: number): Promise<HTMLImageElement> {
  const key = `${z}/${x}/${y}`
  if (labelTileCache.has(key)) return Promise.resolve(labelTileCache.get(key)!)

  const subdomain = MAP_TILE_SUBDOMAINS[(x + y) % MAP_TILE_SUBDOMAINS.length]
  const retina    = window.devicePixelRatio >= 2 ? '@2x' : ''

  const url = MAP_LABEL_TILE_URL
    .replace('{s}', subdomain)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', retina)

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (labelTileCache.size >= LABEL_TILE_CACHE_MAX) {
        const firstKey = labelTileCache.keys().next().value
        if (firstKey) labelTileCache.delete(firstKey)
      }
      labelTileCache.set(key, img)
      resolve(img)
    }
    img.onerror = reject
    img.src = url
  })
}

// ─── Globe Constants ──────────────────────────────────────────────────────────

/** Zoom thresholds for globe / flat map crossfade */
const GLOBE_FULL_ZOOM = 5      // Globe fully visible at zoom <= 5
const GLOBE_GONE_ZOOM = 6.5    // Globe fully hidden at zoom >= 6.5

/** Compute globe opacity from current zoom with ease-in-out curve.
 *  1.0 at zoom <= 5, 0.0 at zoom >= 6.5, smooth cosine blend between.
 *  Cosine easing starts/ends slowly and accelerates through the middle —
 *  feels more natural than a linear ramp during crossfade. */
function globeOpacity(zoom: number): number {
  if (zoom <= GLOBE_FULL_ZOOM) return 1
  if (zoom >= GLOBE_GONE_ZOOM) return 0
  const t = (zoom - GLOBE_FULL_ZOOM) / (GLOBE_GONE_ZOOM - GLOBE_FULL_ZOOM)
  return 0.5 + 0.5 * Math.cos(Math.PI * t)
}

/** Compute the flat-map zoom level that matches the globe's visible scale.
 *  This ensures the flat map renders at the same geographic extent as the globe
 *  during the crossfade, so features align pixel-perfectly at screen center.
 *
 *  Derivation: On a unit sphere at camera distance d with FOV θ, the globe
 *  subtends ~2*atan(1/d) radians of arc. A Mercator flat map at zoom z shows
 *  360 / 2^z degrees across TILE_SIZE pixels. We match degrees-per-pixel. */
function globeEquivFlatZoom(camZ: number, viewHeight: number): number {
  const fovRad = 45 * Math.PI / 180
  const halfFovTan = Math.tan(fovRad / 2)
  // Globe: visible degrees across screen ≈ 2 * asin(min(1, 1/camZ)) * (180/π)
  // But for scale matching we want deg/px: (visible arc in degrees) / viewHeight
  const visibleArcRad = camZ > 1 ? 2 * Math.asin(1 / camZ) : Math.PI
  const globeDegPerPx = (visibleArcRad * (180 / Math.PI)) / viewHeight
  // Flat map: degPerPx = 360 / (TILE_SIZE * 2^z)
  // Solve: 2^z = 360 / (TILE_SIZE * globeDegPerPx)
  const equivZoom = Math.log2(360 / (TILE_SIZE * globeDegPerPx))
  return equivZoom
}

/** Map zoom level to camera Z distance from globe center.
 *
 * Formula: z = 1.2 + 4.5 * 0.65^zoom
 *
 * Designed so the globe fills the viewport by the transition zone (zoom 4+),
 * eliminating the visible circle-over-map artifact during crossfade.
 *
 *   Zoom 1: d≈4.1 → globe subtends ~32° of 45° FOV → full globe with space
 *   Zoom 2: d≈3.1 → ~38° → globe nearly fills screen
 *   Zoom 3: d≈2.4 → ~48° → globe just fills screen (edge at viewport border)
 *   Zoom 4: d≈2.0 → ~60° → globe overflows viewport, no visible edge
 *   Zoom 5: d≈1.7 → ~68° → globe surface looks nearly flat
 *   Zoom 6: d≈1.5 → ~77° → globe surface looks flat, max magnification
 */
function zoomToCameraZ(zoom: number): number {
  const z = 1.2 + 4.5 * Math.pow(0.65, zoom)
  return clamp(z, 1.15, 5.0)
}

/**
 * Convert sphere rotation (euler X, Y) to the lat/lng facing the camera.
 *
 * SphereGeometry places u=0.25 (lng −90°) at +Z (facing camera) when rotation.y=0.
 * Positive rotation.y shifts the visible center westward:
 *   visible_lng = −90 − rotY × (180/π)
 * Latitude is a direct tilt: visible_lat = rotX × (180/π)
 */
function sphereRotationToLatLng(rotX: number, rotY: number): { lat: number; lng: number } {
  let lat = rotX * (180 / Math.PI)
  let lng = -90 - rotY * (180 / Math.PI)
  lat = clamp(lat, -85, 85)
  lng = ((lng + 180) % 360 + 360) % 360 - 180
  return { lat, lng }
}

/**
 * Convert lat/lng to sphere rotation euler angles (inverse of above).
 *   rotY = −(lng + 90) × (π/180)
 *   rotX = lat × (π/180)
 */
function latLngToSphereRotation(lat: number, lng: number): { rotX: number; rotY: number } {
  return {
    rotX: lat * (Math.PI / 180),
    rotY: -(lng + 90) * (Math.PI / 180),
  }
}

// ─── Mercator UV Remapping ───────────────────────────────────────────────────

/**
 * Remap a SphereGeometry's UV coordinates from equirectangular to Web Mercator.
 *
 * Standard SphereGeometry UVs map V linearly with latitude:
 *   v_equirect = (π/2 - φ) / π   where φ is geographic latitude in radians
 *
 * Web Mercator tiles use:
 *   v_mercator = (1 - ln(tan(φ) + sec(φ)) / π) / 2
 *
 * Without this fix, continents appear distorted — the poles are stretched
 * and mid-latitudes are compressed compared to the Mercator tile texture.
 *
 * We also clamp to the Mercator limit of ±85.051° to avoid singularities.
 */
function remapSphereUVsToMercator(geometry: THREE.SphereGeometry): void {
  const uvAttr = geometry.getAttribute('uv')
  const posAttr = geometry.getAttribute('position')
  const count = posAttr.count

  for (let i = 0; i < count; i++) {
    const y = posAttr.getY(i) // on a unit sphere, y = cos(θ) where θ is polar angle
    // Geographic latitude: φ = asin(y) for a unit sphere
    let lat = Math.asin(clamp(y, -1, 1))
    // Clamp to Mercator limit (~85.051°)
    const MERC_LIMIT = 85.051 * (Math.PI / 180)
    lat = clamp(lat, -MERC_LIMIT, MERC_LIMIT)

    // Mercator V: 0 at north pole, 1 at south pole (matching tile texture layout)
    // Three.js SphereGeometry however has v=1 at top (north) and v=0 at bottom (south),
    // so we invert with (1 - mercV) to align the texture correctly.
    const mercV = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2

    uvAttr.setY(i, 1 - mercV)
  }
  uvAttr.needsUpdate = true
}

// ─── Globe Texture Builder ───────────────────────────────────────────────────

const globeTextureCache = new Map<number, HTMLCanvasElement>()

/**
 * Build a globe-ready DEM texture by stitching tiles and brightening for globe view.
 *
 * The standard DEM colors are very dark (sea level is near-black). On the flat map
 * this works because the screen is close and the eye adapts. On a globe floating in
 * space, it looks like a dark blob. We apply a brightness lift:
 *   - Boost RGB channels by ~40% to make terrain features visible from space
 *   - This only affects the globe texture, not the flat map tiles
 */
async function buildGlobeTexture(
  z: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<HTMLCanvasElement> {
  if (globeTextureCache.has(z)) return globeTextureCache.get(z)!

  const tilesPerSide = Math.pow(2, z)
  const texSize = tilesPerSide * TILE_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = texSize
  canvas.height = texSize
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#0a1628'
  ctx.fillRect(0, 0, texSize, texSize)

  const total = tilesPerSide * tilesPerSide
  let loaded = 0

  const promises: Promise<void>[] = []
  for (let ty = 0; ty < tilesPerSide; ty++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      promises.push(
        loadDEMTile(z, tx, ty)
          .then((tileCanvas) => {
            ctx.drawImage(tileCanvas, tx * TILE_SIZE, ty * TILE_SIZE)
            loaded++
            onProgress?.(loaded, total)
          })
          .catch(() => {
            loaded++
            onProgress?.(loaded, total)
            log.debug('Globe tile unavailable', { z, tx, ty })
          })
      )
    }
  }

  await Promise.all(promises)

  // Brightness lift for globe view — make terrain features visible from space
  const imageData = ctx.getImageData(0, 0, texSize, texSize)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    // Lift: add a base floor + scale up. Keeps relative differences but raises the floor.
    data[i]     = Math.min(255, Math.round(data[i]     * 1.5 + 18)) // R
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * 1.4 + 22)) // G
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * 1.3 + 28)) // B
  }
  ctx.putImageData(imageData, 0, 0)

  globeTextureCache.set(z, canvas)
  log.info('Globe texture built', { z, tilesPerSide, texSize })
  return canvas
}

// ─── Star Field ──────────────────────────────────────────────────────────────

function createStarField(): THREE.Points {
  const count = 300
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 40 + Math.random() * 20
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
    sizes[i] = 0.03 + Math.random() * 0.1
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
  const material = new THREE.PointsMaterial({
    color: 0xd0e4f0,
    size: 0.1,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
  })
  return new THREE.Points(geometry, material)
}

// ─── Atmosphere Shader ───────────────────────────────────────────────────────

/**
 * Fresnel-based atmosphere glow.
 *   - Thin glow sphere (r=1.06) — just slightly larger than Earth for a subtle rim
 *   - Steep Fresnel power (3.0) — glow concentrated at the very edge, fades fast
 *   - Low alpha cap (0.35) — translucent haze, never solid/opaque
 *   - BackSide rendering so glow is visible as a rim behind the Earth
 *   - Additive blending for bright, airy halo
 */
const atmosphereVertexShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const atmosphereFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  void main() {
    vec3 viewDir = normalize(-vPosition);
    float rim = 1.0 - max(0.0, dot(vNormal, viewDir));
    // Steep falloff: pow 3.0 concentrates glow at the very edge
    float intensity = pow(rim, 3.0) * 1.0;
    // Low alpha cap — translucent haze, fades to 0 at outer edge
    float alpha = intensity * 0.35;
    // Ocean-depth palette glow: mix of ec-mid (#4B8EA3) and ec-glow (#84D1DB)
    vec3 glowColor = mix(vec3(0.29, 0.56, 0.64), vec3(0.52, 0.82, 0.86), rim);
    gl_FragColor = vec4(glowColor * intensity, alpha);
  }
`

// ─── Main Component ────────────────────────────────────────────────────────────

const MapScreen: React.FC = () => {
  const { activeLat, activeLng, gpsLat, gpsLng, gpsPermission, mode, setExploreLocation, switchToGPS, requestGPS } = useLocationStore()
  const { peaks, meshData, activeRegion } = useTerrainStore()
  const { coordFormat, showPeakLabels, units } = useSettingsStore()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const globeCanvasRef = useRef<HTMLCanvasElement>(null)

  const [centerLat, setCenterLat] = useState(DEFAULT_MAP_CENTER.lat)
  const [centerLng, setCenterLng] = useState(DEFAULT_MAP_CENTER.lng)
  const [zoom, setZoom]           = useState(DEFAULT_MAP_ZOOM)
  const [isLoading, setIsLoading] = useState(false)

  // ── Globe State ──────────────────────────────────────────────────────────
  const [globeReady, setGlobeReady] = useState(false)
  const [globeTextureZoom, setGlobeTextureZoom] = useState<number | null>(null)
  const [globeTilesLoaded, setGlobeTilesLoaded] = useState(0)
  const [globeTilesTotal, setGlobeTilesTotal] = useState(0)
  const [showGlobeDebug, setShowGlobeDebug] = useState(false)

  // Debug counters
  const globeRenderCountRef = useRef(0)
  const flatMapDrawCountRef = useRef(0)
  const lastFlatMapDrawRef = useRef<string>('never')

  // Three.js refs (persist across renders, cleaned up on unmount)
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    earth: THREE.Mesh
    atmosphere: THREE.Mesh
    stars: THREE.Points
    earthMaterial: THREE.MeshBasicMaterial
    locationMarker: THREE.Sprite
    animFrameId: number
    needsRender: boolean
  } | null>(null)

  // Track current zoom for on-demand render decisions (avoids stale closure)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // On-demand globe render — call this whenever the scene changes
  const requestGlobeRenderRef = useRef<() => void>(() => {})
  const requestGlobeRender = useCallback(() => requestGlobeRenderRef.current(), [])

  // Globe drag state
  const globeDragRef = useRef({
    isDragging: false,
    hasMoved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    velocityX: 0,
    velocityY: 0,
  })

  // GPS permission prompt — shown when user taps "My Location" without permission
  const [gpsPrompt, setGpsPrompt] = useState<'needs-permission' | 'denied' | 'unavailable' | null>(null)
  const gpsPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showTapHint, setShowTapHint] = useState(true)

  const [cursorLat, setCursorLat] = useState(DEFAULT_MAP_CENTER.lat)
  const [cursorLng, setCursorLng] = useState(DEFAULT_MAP_CENTER.lng)

  // ── Area Selection State ──────────────────────────────────────────────────
  // Selection mode lets users draw a rectangle on the map to define a region
  // for the EXPLORE 3D view. The rectangle shows live dimensions and color-codes
  // based on data size:
  //
  //   HOW IT WORKS:
  //   1. User taps the rectangle icon (bottom-right controls) to enter selection mode
  //   2. Drag on the map to draw a rectangle
  //   3. Live dimensions shown inside the rectangle (respects imperial/metric)
  //   4. Rectangle color indicates feasibility:
  //      - Teal (≤300 km/side): Good — fast load, accurate projection
  //      - Orange (300–500 km): Large — may be slow on mobile devices
  //      - Red (>500 km): Too large — will likely crash on mobile (100+ MB stitched grid)
  //   5. Tap EXPLORE to load the selected bounds in the EXPLORE 3D screen
  //
  //   SIZE THRESHOLDS (based on EXPLORE's z=10 tile pipeline):
  //   - At z=10, each tile is ~0.35° (~35 km). Tiles are fetched, decoded (262 KB each),
  //     stitched into a pixel grid, then downsampled to 256×256.
  //   - 300 km/side ≈ 64 tiles ≈ 17 MB stitched — comfortable on all devices
  //   - 500 km/side ≈ 196 tiles ≈ 100 MB stitched — strains mobile browsers
  //   - 1000 km/side ≈ 784 tiles ≈ 400 MB stitched — OOM on most phones
  //
  //   Offline downloads are handled separately via predetermined regions in Settings,
  //   not via this drag-select (curated regions ensure correct size + accurate estimates).
  const [isSelectingArea, setIsSelectingArea] = useState(false)
  const [selectionStart, setSelectionStart] = useState<{ lat: number; lng: number } | null>(null)
  const [selectionEnd, setSelectionEnd] = useState<{ lat: number; lng: number } | null>(null)
  const selectionDragRef = useRef(false)

  // ── Selection dimension computation ─────────────────────────────────────
  // Computes width/height in km from the lat/lng selection bounds.
  // Uses simple spherical math: 111.132 km/° lat, 111.320×cos(lat) km/° lng.
  const selectionDims = React.useMemo(() => {
    if (!selectionStart || !selectionEnd) return null
    const latRange = Math.abs(selectionEnd.lat - selectionStart.lat)
    const lngRange = Math.abs(selectionEnd.lng - selectionStart.lng)
    const midLat = (selectionStart.lat + selectionEnd.lat) / 2
    const heightKm = latRange * 111.132
    const widthKm = lngRange * 111.320 * Math.cos((midLat * Math.PI) / 180)
    const maxSideKm = Math.max(widthKm, heightKm)
    // Estimate tile count at z=10: each tile ~0.35° (360/1024)
    const tilesWide = Math.ceil(lngRange / (360 / 1024)) + 2
    const tilesTall = Math.ceil(latRange / (360 / 1024)) + 2
    const tileCount = tilesWide * tilesTall
    const estimatedMB = (tileCount * 262144) / (1024 * 1024) // stitched grid ~262 KB/tile decoded
    return { widthKm, heightKm, maxSideKm, tileCount, estimatedMB }
  }, [selectionStart, selectionEnd])

  // Color-code selection based on size thresholds
  type SelectionSeverity = 'ok' | 'warning' | 'danger'
  const selectionSeverity: SelectionSeverity = !selectionDims ? 'ok'
    : selectionDims.maxSideKm > 500 ? 'danger'
    : selectionDims.maxSideKm > 300 ? 'warning'
    : 'ok'

  const dragRef = useRef({
    isDragging: false,
    startX: 0, startY: 0,
    startCenterLat: DEFAULT_MAP_CENTER.lat,
    startCenterLng: DEFAULT_MAP_CENTER.lng,
    hasMoved: false,
  })

  const pinchRef    = useRef({ isPinching: false, startDist: 0, startZoom: DEFAULT_MAP_ZOOM })
  const loadingRef  = useRef(0)
  const drawMapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  log.debug('MapScreen render', {
    center: `${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}`,
    zoom,
    mode,
    hasRegion: !!activeRegion,
  })

  // ── Canvas Draw ─────────────────────────────────────────────────────────────

  const drawMap = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Skip flat map rendering entirely when globe is fully visible — saves
    // massive tile loading work at zoom 1-4 where the flat map is invisible
    if (globeOpacity(zoom) >= 1) {
      log.debug('Skipping flat map draw — globe fully visible', { zoom })
      lastFlatMapDrawRef.current = `skipped (globe α=1, z=${zoom.toFixed(1)})`
      return
    }

    flatMapDrawCountRef.current++
    lastFlatMapDrawRef.current = `draw #${flatMapDrawCountRef.current} z=${zoom.toFixed(1)}`

    const ctx = canvas.getContext('2d')
    if (!ctx) { log.error('Canvas 2D context unavailable'); return }

    // Use CSS pixel dimensions — ctx.scale(dpr) set by the resize observer
    // maps these to physical pixels.  This keeps drawing coordinates consistent
    // with pointer handlers (which use getBoundingClientRect = CSS pixels),
    // so tap-to-explore, hover readout, and drawn features all share one GPS grid.
    const dpr = window.devicePixelRatio || 1
    const W = canvas.width  / dpr
    const H = canvas.height / dpr

    const thisGeneration = ++loadingRef.current

    // Use integer zoom for tile operations — tiles are only available at integer levels.
    // Fractional zoom is used for smooth slider/pinch feel; tiles snap to the nearest int.
    // During globe→flat transition, render the flat map at the globe's equivalent zoom
    // so both views show the same geographic extent — features align during crossfade.
    const gOp = globeOpacity(zoom)
    let effectiveZoom = zoom
    if (gOp > 0 && gOp < 1) {
      const camZ = zoomToCameraZ(zoom)
      const equivZ = globeEquivFlatZoom(camZ, H)
      // Blend from globe-equivalent zoom toward the actual zoom as globe fades
      effectiveZoom = equivZ + (1 - gOp) * (zoom - equivZ)
    }
    const tileZoom = Math.max(2, Math.round(effectiveZoom))

    log.debug('Drawing DEM map', { W, H, zoom, tileZoom, center: `${centerLat.toFixed(4)},${centerLng.toFixed(4)}` })

    // Dark ocean base — fills any gaps between tiles while loading
    ctx.fillStyle = '#000810'
    ctx.fillRect(0, 0, W, H)

    // ── Calculate tile range ────────────────────────────────────────────────
    const tileCountX = Math.ceil(W / TILE_SIZE) + 2
    const tileCountY = Math.ceil(H / TILE_SIZE) + 2

    const centerTile    = latLngToTile(centerLat, centerLng, tileZoom)
    const centerTileTopLeft = tileToLatLng(centerTile.x, centerTile.y, tileZoom)
    const centerTilePixel = latLngToPixel(
      centerTileTopLeft.lat, centerTileTopLeft.lng,
      centerLat, centerLng, tileZoom, W, H,
    )

    const startTileX = centerTile.x - Math.floor(tileCountX / 2)
    const startTileY = centerTile.y - Math.floor(tileCountY / 2)

    setIsLoading(true)

    // ── Pre-compute tile positions (reused by both DEM and label passes) ──────
    type TileJob = { wrappedX: number; tileY: number; pixelX: number; pixelY: number }
    const tileJobs: TileJob[] = []

    for (let ty = 0; ty < tileCountY; ty++) {
      for (let tx = 0; tx < tileCountX; tx++) {
        const tileX    = startTileX + tx
        const tileY    = startTileY + ty
        const maxTile  = Math.pow(2, tileZoom)
        const wrappedX = ((tileX % maxTile) + maxTile) % maxTile
        if (tileY < 0 || tileY >= maxTile) continue

        const tileTL    = tileToLatLng(wrappedX, tileY, tileZoom)
        const tilePixel = latLngToPixel(
          tileTL.lat, tileTL.lng,
          centerLat, centerLng, tileZoom, W, H,
        )
        tileJobs.push({
          wrappedX,
          tileY,
          pixelX: Math.round(tilePixel.x),
          pixelY: Math.round(tilePixel.y),
        })
      }
    }

    // ── Pass 1: DEM elevation tiles ─────────────────────────────────────────
    await Promise.all(tileJobs.map(({ wrappedX, tileY, pixelX, pixelY }) =>
      loadDEMTile(tileZoom, wrappedX, tileY)
        .then((tileCanvas) => {
          if (thisGeneration !== loadingRef.current) return
          ctx.drawImage(tileCanvas, pixelX, pixelY, TILE_SIZE, TILE_SIZE)
        })
        .catch(() => {
          log.debug('DEM tile unavailable, leaving base fill', { x: wrappedX, y: tileY })
        }),
    ))
    if (thisGeneration !== loadingRef.current) return

    // ── Pass 2: Label overlay (towns, cities, roads) ─────────────────────────
    await Promise.all(tileJobs.map(({ wrappedX, tileY, pixelX, pixelY }) =>
      loadLabelTile(tileZoom, wrappedX, tileY)
        .then((img) => {
          if (thisGeneration !== loadingRef.current) return
          ctx.drawImage(img, pixelX, pixelY, TILE_SIZE, TILE_SIZE)
        })
        .catch(() => {
          // Label tiles are optional — silent fail if CDN is unavailable
        }),
    ))
    if (thisGeneration !== loadingRef.current) return

    // ── Loaded region border ───────────────────────────────────────────────
    if (activeRegion && meshData) {
      const { bounds } = activeRegion
      const nw = latLngToPixel(bounds.north, bounds.west, centerLat, centerLng, tileZoom, W, H)
      const se = latLngToPixel(bounds.south, bounds.east, centerLat, centerLng, tileZoom, W, H)

      const rx = Math.round(nw.x)
      const ry = Math.round(nw.y)
      const rw = Math.round(se.x - nw.x)
      const rh = Math.round(se.y - nw.y)

      ctx.save()
      ctx.shadowColor = 'rgba(132, 209, 219, 0.8)'
      ctx.shadowBlur  = 16
      ctx.strokeStyle = 'rgba(132, 209, 219, 0.85)'
      ctx.lineWidth   = 2
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.shadowBlur  = 32
      ctx.strokeStyle = 'rgba(132, 209, 219, 0.25)'
      ctx.lineWidth   = 8
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.restore()

      if (rw > 80 && rh > 24) {
        ctx.save()
        ctx.font      = `bold 10px 'Josefin Sans', sans-serif`
        ctx.fillStyle = 'rgba(132, 209, 219, 0.9)'
        ctx.textAlign = 'left'
        ctx.shadowColor = 'rgba(132, 209, 219, 0.7)'
        ctx.shadowBlur  = 6
        ctx.fillText('▣ ' + activeRegion.name.toUpperCase(), rx + 6, ry + 15)
        ctx.restore()
      }
    }

    // ── GPS "ghost" dot (dimmed blue) ────────────────────────────────────────
    // When in explore mode, show a faint blue dot at the GPS position so the
    // user can still see where they physically are vs. where they tapped.
    // In GPS mode, skip this — the active dot below handles it.
    // TODO: Animate the accuracy ring pulse when GPS is actively updating.
    // TODO: Show accuracy radius scaled to map zoom level.
    if (mode === 'exploring' && gpsLat !== null && gpsLng !== null) {
      const gpsPx = latLngToPixel(gpsLat, gpsLng, centerLat, centerLng, tileZoom, W, H)
      if (gpsPx.x >= 0 && gpsPx.x <= W && gpsPx.y >= 0 && gpsPx.y <= H) {
        // Dimmed accuracy halo
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 12, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(70, 130, 230, 0.1)'
        ctx.fill()
        // Dimmed outer ring
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 8, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(70, 130, 230, 0.3)'
        ctx.lineWidth = 1
        ctx.stroke()
        // Small dimmed dot
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(70, 130, 230, 0.5)'
        ctx.fill()
      }
    }

    // ── Active viewpoint dot ─────────────────────────────────────────────────
    // Single prominent dot for the active location (what SCAN/EXPLORE are using).
    // Blue when GPS is active, teal when user tapped a location.
    {
      const dotLat = activeLat
      const dotLng = activeLng
      const isGps = mode === 'gps'
      const color = isGps ? '#4682E6' : '#84D1DB'
      const colorRgba = isGps ? 'rgba(70, 130, 230,' : 'rgba(132, 209, 219,'

      const dotPx = latLngToPixel(dotLat, dotLng, centerLat, centerLng, tileZoom, W, H)
      if (dotPx.x >= 0 && dotPx.x <= W && dotPx.y >= 0 && dotPx.y <= H) {
        // Outer halo
        ctx.beginPath()
        ctx.arc(dotPx.x, dotPx.y, 14, 0, Math.PI * 2)
        ctx.fillStyle = `${colorRgba} 0.15)`
        ctx.fill()
        // Ring
        ctx.beginPath()
        ctx.arc(dotPx.x, dotPx.y, 10, 0, Math.PI * 2)
        ctx.strokeStyle = `${colorRgba} 0.5)`
        ctx.lineWidth = 1.5
        ctx.stroke()
        // Inner dot
        ctx.beginPath()
        ctx.arc(dotPx.x, dotPx.y, 5, 0, Math.PI * 2)
        ctx.fillStyle   = color
        ctx.shadowColor = color
        ctx.shadowBlur  = 8
        ctx.fill()
        ctx.shadowBlur  = 0
      }
    }

    // ── Peak markers ─────────────────────────────────────────────────────────
    if (showPeakLabels && tileZoom >= 8) {
      ctx.font      = `bold 11px 'Josefin Sans', sans-serif`
      ctx.textAlign = 'center'

      for (const peak of peaks.slice(0, 20)) {
        const px = latLngToPixel(peak.lat, peak.lng, centerLat, centerLng, tileZoom, W, H)
        if (px.x < -20 || px.x > W + 20 || px.y < -20 || px.y > H + 20) continue

        ctx.fillStyle   = '#A7DDE5'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur  = 4
        ctx.fillText('▲', px.x, px.y)
        ctx.shadowBlur  = 0

        if (tileZoom >= 10) {
          ctx.font      = `10px 'Josefin Sans', sans-serif`
          ctx.fillStyle = 'rgba(167, 221, 229, 0.9)'
          ctx.fillText(peak.name, px.x, px.y + 14)
        }
      }
    }

    // ── Area selection rectangle ──────────────────────────────────────────────
    // Color-coded by data size: teal (ok), orange (warning), red (danger).
    // Shows live dimensions inside the rectangle (imperial or metric).
    if (isSelectingArea && selectionStart && selectionEnd) {
      const startPx = latLngToPixel(selectionStart.lat, selectionStart.lng, centerLat, centerLng, tileZoom, W, H)
      const endPx   = latLngToPixel(selectionEnd.lat, selectionEnd.lng, centerLat, centerLng, tileZoom, W, H)

      const rx = Math.min(startPx.x, endPx.x)
      const ry = Math.min(startPx.y, endPx.y)
      const rw = Math.abs(endPx.x - startPx.x)
      const rh = Math.abs(endPx.y - startPx.y)

      // Color based on severity
      const sevColors = {
        ok:      { fill: 'rgba(132, 209, 219, 0.1)',  stroke: 'rgba(132, 209, 219, 0.7)',  handle: '#84D1DB',  text: 'rgba(132, 209, 219, 0.9)' },
        warning: { fill: 'rgba(230, 160, 50, 0.12)',  stroke: 'rgba(230, 160, 50, 0.8)',   handle: '#E6A032',  text: 'rgba(230, 180, 80, 0.95)' },
        danger:  { fill: 'rgba(220, 70, 70, 0.12)',   stroke: 'rgba(220, 70, 70, 0.8)',    handle: '#DC4646',  text: 'rgba(230, 90, 90, 0.95)' },
      }
      const sc = sevColors[selectionSeverity]

      ctx.save()
      // Semi-transparent fill
      ctx.fillStyle = sc.fill
      ctx.fillRect(rx, ry, rw, rh)
      // Dashed border
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = sc.stroke
      ctx.lineWidth = 2
      ctx.strokeRect(rx, ry, rw, rh)
      // Corner handles
      const handleSize = 8
      ctx.fillStyle = sc.handle
      ctx.setLineDash([])
      for (const [hx, hy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) {
        ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize)
      }

      // Dimension label inside rectangle (if large enough to read)
      if (selectionDims && rw > 60 && rh > 30) {
        const wLabel = formatDistance(selectionDims.widthKm, units)
        const hLabel = formatDistance(selectionDims.heightKm, units)
        const dimText = `${wLabel} × ${hLabel}`

        ctx.font      = `bold 11px 'Josefin Sans', sans-serif`
        ctx.textAlign = 'center'
        ctx.fillStyle = sc.text
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
        ctx.shadowBlur  = 4
        ctx.fillText(dimText, rx + rw / 2, ry + rh / 2 + 4)
        ctx.shadowBlur = 0
      }
      ctx.restore()
    }

    // ── Elevation legend ──────────────────────────────────────────────────────
    //
    // Draws a vertical gradient bar on the left showing the color → elevation mapping.
    drawElevationLegend(ctx, W, H)

    // ── Attribution ──────────────────────────────────────────────────────────
    ctx.font      = '10px Arial, sans-serif'
    ctx.fillStyle = 'rgba(240, 248, 255, 0.4)'
    ctx.textAlign = 'right'
    ctx.shadowBlur = 0
    ctx.fillText(DEM_ATTRIBUTION, W - 8, H - 8)

    setIsLoading(false)
    log.debug('DEM map draw complete')
  }, [centerLat, centerLng, zoom, gpsLat, gpsLng, activeLat, activeLng, mode, peaks, showPeakLabels, activeRegion, meshData, selectionStart, selectionEnd, isSelectingArea, selectionSeverity, selectionDims, units])

  // ── Resize observer ──────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        canvas.width  = Math.round(width  * window.devicePixelRatio)
        canvas.height = Math.round(height * window.devicePixelRatio)
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
        log.debug('Canvas resized', { width, height })
        drawMap()
      }
    })

    observer.observe(canvas)
    return () => observer.disconnect()
  }, [drawMap])

  // Debounce drawMap — prevents tile loading storms during smooth zoom slider drags.
  // 120ms delay is short enough to feel responsive, long enough to skip intermediate steps.
  useEffect(() => {
    if (drawMapTimerRef.current) clearTimeout(drawMapTimerRef.current)
    drawMapTimerRef.current = setTimeout(() => {
      drawMap()
      drawMapTimerRef.current = null
    }, 120)
    return () => {
      if (drawMapTimerRef.current) clearTimeout(drawMapTimerRef.current)
    }
  }, [drawMap])

  // ── Three.js Globe Setup ──────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = globeCanvasRef.current
    if (!canvas) return

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    })
    renderer.setClearColor(0x000810)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // Scene
    const scene = new THREE.Scene()

    // Camera
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
    camera.position.set(0, 0, zoomToCameraZ(zoom))

    // No lights needed — MeshBasicMaterial is unlit (texture colors are the final output).
    // This prevents Lambert lighting from darkening our already-dark DEM colors.

    // Earth sphere with Mercator-corrected UVs
    const earthGeo = new THREE.SphereGeometry(1, 96, 96)
    remapSphereUVsToMercator(earthGeo)
    // MeshBasicMaterial — unlit, shows texture colors as-is without lighting darkening
    const earthMat = new THREE.MeshBasicMaterial({ color: 0x111111 })
    const earth = new THREE.Mesh(earthGeo, earthMat)
    // Set initial rotation from current centerLat/centerLng
    const initRot = latLngToSphereRotation(centerLat, centerLng)
    earth.rotation.x = initRot.rotX
    earth.rotation.y = initRot.rotY
    scene.add(earth)

    // Location marker — sprite with canvas-rendered texture matching the flat map dot.
    // 3-layer design: outer halo, ring, inner dot with glow — consistent across views.
    const markerCanvas = document.createElement('canvas')
    markerCanvas.width = 64
    markerCanvas.height = 64
    const mCtx = markerCanvas.getContext('2d')!
    const mc = 32 // center
    // Outer halo
    mCtx.beginPath()
    mCtx.arc(mc, mc, 28, 0, Math.PI * 2)
    mCtx.fillStyle = 'rgba(132, 209, 219, 0.15)'
    mCtx.fill()
    // Ring
    mCtx.beginPath()
    mCtx.arc(mc, mc, 20, 0, Math.PI * 2)
    mCtx.strokeStyle = 'rgba(132, 209, 219, 0.5)'
    mCtx.lineWidth = 2
    mCtx.stroke()
    // Inner dot with glow
    mCtx.beginPath()
    mCtx.arc(mc, mc, 10, 0, Math.PI * 2)
    mCtx.fillStyle = '#84D1DB'
    mCtx.shadowColor = '#84D1DB'
    mCtx.shadowBlur = 12
    mCtx.fill()
    mCtx.shadowBlur = 0
    const markerTex = new THREE.CanvasTexture(markerCanvas)
    const markerSpriteMat = new THREE.SpriteMaterial({
      map: markerTex,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true,
    })
    const locationMarker = new THREE.Sprite(markerSpriteMat)
    locationMarker.scale.set(0.06, 0.06, 1)
    locationMarker.renderOrder = 999
    locationMarker.visible = false
    earth.add(locationMarker)

    // Atmosphere glow — thin sphere (r=1.06) with BackSide rendering
    // creates a subtle rim glow behind the Earth edge
    const atmosGeo = new THREE.SphereGeometry(1.06, 64, 64)
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    })
    const atmosphere = new THREE.Mesh(atmosGeo, atmosMat)
    scene.add(atmosphere)

    // Stars
    const stars = createStarField()
    scene.add(stars)

    // Store refs
    threeRef.current = {
      renderer, scene, camera, earth, atmosphere, stars,
      earthMaterial: earthMat as THREE.MeshBasicMaterial,
      locationMarker,
      animFrameId: 0,
      needsRender: false,
    }

    // Resize handler for globe canvas
    const resizeGlobe = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      requestGlobeRender()
    }
    resizeGlobe()

    const resizeObs = new ResizeObserver(resizeGlobe)
    resizeObs.observe(canvas)

    // On-demand render loop — only runs when needsRender is set or momentum is active.
    // Stops scheduling new frames once the scene is static (no momentum, no pending changes).
    const animate = () => {
      const t = threeRef.current
      if (!t) return

      let keepAnimating = false

      // Apply momentum if not dragging
      const gd = globeDragRef.current
      if (!gd.isDragging && (Math.abs(gd.velocityX) > 0.0001 || Math.abs(gd.velocityY) > 0.0001)) {
        t.earth.rotation.y += gd.velocityX
        t.earth.rotation.x += gd.velocityY
        // Clamp latitude rotation to prevent flipping
        t.earth.rotation.x = clamp(t.earth.rotation.x, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05)
        gd.velocityX *= 0.95
        gd.velocityY *= 0.95

        // Sync centerLat/centerLng from globe rotation
        const { lat, lng } = sphereRotationToLatLng(t.earth.rotation.x, t.earth.rotation.y)
        setCenterLat(lat)
        setCenterLng(lng)

        // Keep animating while momentum is active
        keepAnimating = true
      }

      t.renderer.render(t.scene, t.camera)
      globeRenderCountRef.current++
      t.needsRender = false

      // Only schedule next frame if momentum is still decaying
      if (keepAnimating) {
        t.animFrameId = requestAnimationFrame(animate)
      }
    }

    // Helper to request a single render frame (called from interaction handlers, zoom changes, etc.)
    requestGlobeRenderRef.current = () => {
      const t = threeRef.current
      if (!t || t.needsRender) return  // already scheduled
      t.needsRender = true
      t.animFrameId = requestAnimationFrame(animate)
    }

    // Initial render
    requestGlobeRenderRef.current()

    // Load globe texture: z=2 first (fast), then z=3 (detail)
    setGlobeReady(false)
    buildGlobeTexture(2, (loaded, total) => {
      setGlobeTilesLoaded(loaded)
      setGlobeTilesTotal(total)
    }).then((tex2) => {
      if (!threeRef.current) return
      const t = new THREE.CanvasTexture(tex2)
      t.colorSpace = THREE.SRGBColorSpace
      threeRef.current.earthMaterial.map = t
      threeRef.current.earthMaterial.color.set(0xffffff)
      threeRef.current.earthMaterial.needsUpdate = true
      setGlobeReady(true)
      setGlobeTextureZoom(2)
      requestGlobeRenderRef.current()
      log.info('Globe z2 texture applied')

      // Upgrade to z=3 in background
      buildGlobeTexture(3, (loaded, total) => {
        setGlobeTilesLoaded(loaded)
        setGlobeTilesTotal(total)
      }).then((tex3) => {
        if (!threeRef.current) return
        const t3 = new THREE.CanvasTexture(tex3)
        t3.colorSpace = THREE.SRGBColorSpace
        threeRef.current.earthMaterial.map = t3
        threeRef.current.earthMaterial.needsUpdate = true
        setGlobeTextureZoom(3)
        requestGlobeRenderRef.current()
        log.info('Globe z3 texture applied (upgrade)')

        // Pre-cache z4 flat map tiles around center for smooth transition.
        // z4 has 16×16 = 256 tiles total, but we only need the ~6 visible ones.
        // These cache into demTileCache so the flat map draws instantly during crossfade.
        const precacheZ = 4
        const ct = latLngToTile(centerLat, centerLng, precacheZ)
        const radius = 2
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const tx = ((ct.x + dx) % (1 << precacheZ) + (1 << precacheZ)) % (1 << precacheZ)
            const ty = ct.y + dy
            if (ty >= 0 && ty < (1 << precacheZ)) {
              loadDEMTile(precacheZ, tx, ty).catch(() => {})
            }
          }
        }
        log.info('Pre-cached z4 flat tiles for transition')
      })
    })

    return () => {
      resizeObs.disconnect()
      if (threeRef.current) {
        cancelAnimationFrame(threeRef.current.animFrameId)
        threeRef.current.renderer.dispose()
        threeRef.current.earthMaterial.dispose()
        const smMat = threeRef.current.locationMarker.material as THREE.SpriteMaterial
        smMat.map?.dispose()
        smMat.dispose()
        earthGeo.dispose()
        atmosGeo.dispose()
        atmosMat.dispose()
      }
      threeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Sync globe camera Z and rotation from zoom/center ─────────────────────

  useEffect(() => {
    const t = threeRef.current
    if (!t) return
    t.camera.position.z = zoomToCameraZ(zoom)
    requestGlobeRender()
  }, [zoom, requestGlobeRender])

  // Sync globe rotation when centerLat/centerLng change from flat map interaction.
  // Always sync — the globe should reflect centerLat/centerLng at every zoom level.
  // The isDragging guard prevents feedback loops during active globe drag.
  useEffect(() => {
    const t = threeRef.current
    if (!t) return
    if (globeDragRef.current.isDragging) return
    const { rotX, rotY } = latLngToSphereRotation(centerLat, centerLng)
    t.earth.rotation.x = rotX
    t.earth.rotation.y = rotY
    requestGlobeRender()
  }, [centerLat, centerLng, zoom, requestGlobeRender])

  // Sync location marker on globe when active location or mode changes.
  // Updates position, color (blue=GPS, teal=exploring), and size (scales with zoom).
  useEffect(() => {
    const t = threeRef.current
    if (!t) return
    const latRad = activeLat * (Math.PI / 180)
    const lngRad = activeLng * (Math.PI / 180)
    const r = 1.015
    t.locationMarker.position.set(
      r * Math.cos(latRad) * Math.cos(lngRad),
      r * Math.sin(latRad),
      r * -Math.cos(latRad) * Math.sin(lngRad),
    )
    // Scale inversely with camera distance so marker stays a consistent screen size
    const camZ = zoomToCameraZ(zoom)
    const s = 0.06 * (camZ / 3)
    t.locationMarker.scale.set(s, s, 1)
    // Redraw marker texture with the right color
    const isGps = mode === 'gps'
    const color = isGps ? '#4682E6' : '#84D1DB'
    const colorAlpha = isGps ? 'rgba(70, 130, 230,' : 'rgba(132, 209, 219,'
    const markerTex = t.locationMarker.material as THREE.SpriteMaterial
    if (markerTex.map) {
      const mc = 32
      const mCanvas = markerTex.map.image as HTMLCanvasElement
      const mCtx = mCanvas.getContext('2d')!
      mCtx.clearRect(0, 0, 64, 64)
      mCtx.beginPath()
      mCtx.arc(mc, mc, 28, 0, Math.PI * 2)
      mCtx.fillStyle = `${colorAlpha} 0.15)`
      mCtx.fill()
      mCtx.beginPath()
      mCtx.arc(mc, mc, 20, 0, Math.PI * 2)
      mCtx.strokeStyle = `${colorAlpha} 0.5)`
      mCtx.lineWidth = 2
      mCtx.stroke()
      mCtx.beginPath()
      mCtx.arc(mc, mc, 10, 0, Math.PI * 2)
      mCtx.fillStyle = color
      mCtx.shadowColor = color
      mCtx.shadowBlur = 12
      mCtx.fill()
      mCtx.shadowBlur = 0
      markerTex.map.needsUpdate = true
    }
    t.locationMarker.visible = true
    requestGlobeRender()
  }, [activeLat, activeLng, zoom, mode, requestGlobeRender])

  // ── Globe Pointer Handlers ────────────────────────────────────────────────

  const isGlobeActive = zoom < GLOBE_GONE_ZOOM

  const handleGlobePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGlobeActive) return
    globeCanvasRef.current?.setPointerCapture(e.pointerId)
    globeDragRef.current = {
      isDragging: true,
      hasMoved: false,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      velocityX: 0,
      velocityY: 0,
    }
  }, [isGlobeActive])

  const handleGlobePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const gd = globeDragRef.current
    if (!gd.isDragging || !threeRef.current) return

    // Detect if pointer has moved enough to count as a drag (not a tap)
    if (!gd.hasMoved) {
      const totalDx = e.clientX - gd.startX
      const totalDy = e.clientY - gd.startY
      if (totalDx * totalDx + totalDy * totalDy > 9) {
        gd.hasMoved = true
      }
    }

    const deltaX = e.clientX - gd.lastX
    const deltaY = e.clientY - gd.lastY
    gd.lastX = e.clientX
    gd.lastY = e.clientY

    const rotScale = 0.005
    const dx = deltaX * rotScale
    const dy = deltaY * rotScale

    threeRef.current.earth.rotation.y += dx
    threeRef.current.earth.rotation.x += dy
    threeRef.current.earth.rotation.x = clamp(
      threeRef.current.earth.rotation.x,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    )

    gd.velocityX = dx
    gd.velocityY = dy

    // Sync centerLat/centerLng from globe rotation (single source of truth)
    const { lat, lng } = sphereRotationToLatLng(
      threeRef.current.earth.rotation.x,
      threeRef.current.earth.rotation.y,
    )
    setCenterLat(lat)
    setCenterLng(lng)
    requestGlobeRender()
  }, [requestGlobeRender])

  const handleGlobePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    globeCanvasRef.current?.releasePointerCapture(e.pointerId)
    const gd = globeDragRef.current
    const wasTap = gd.isDragging && !gd.hasMoved
    gd.isDragging = false

    // ── Globe tap → set explore location via raycast ──
    if (wasTap && threeRef.current) {
      const canvas = globeCanvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

        const raycaster = new THREE.Raycaster()
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), threeRef.current.camera)
        const hits = raycaster.intersectObject(threeRef.current.earth)
        if (hits.length > 0) {
          // Get intersection point in object (unrotated sphere) space
          const localPt = threeRef.current.earth.worldToLocal(hits[0].point.clone())
          // Derive lat/lng from unit sphere position
          // SphereGeometry: x = cos(lat)*cos(lng), y = sin(lat), z = -cos(lat)*sin(lng)
          const lat = Math.asin(clamp(localPt.y, -1, 1)) * (180 / Math.PI)
          const lng = Math.atan2(-localPt.z, localPt.x) * (180 / Math.PI)
          log.info('Globe tap → setting explore location', { lat: lat.toFixed(4), lng: lng.toFixed(4) })
          setExploreLocation(lat, lng)
          setShowTapHint(false)
        }
      }
    }

    // Kick off momentum animation if there's velocity
    if (Math.abs(gd.velocityX) > 0.0001 || Math.abs(gd.velocityY) > 0.0001) {
      requestGlobeRender()
    }
  }, [requestGlobeRender, setExploreLocation])

  // Globe wheel zoom — smooth fractional steps
  const handleGlobeWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.5 : 0.5
    setZoom((z: number) => clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  }, [])

  // Globe pinch zoom
  const globePinchRef = useRef({ isPinching: false, startDist: 0, startZoom: DEFAULT_MAP_ZOOM })

  const handleGlobeTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      globePinchRef.current = { isPinching: true, startDist: dist, startZoom: zoom }
    }
  }, [zoom])

  const handleGlobeTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && globePinchRef.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const scale = dist / globePinchRef.current.startDist
      setZoom(clamp(
        globePinchRef.current.startZoom + Math.log2(scale),
        MAP_MIN_ZOOM,
        MAP_MAX_ZOOM,
      ))
    }
  }, [])

  const handleGlobeTouchEnd = useCallback(() => {
    globePinchRef.current.isPinching = false
  }, [])

  // ── Pointer Handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(e.pointerId)

    // ── Area selection mode: start drawing rectangle ──
    if (isSelectingArea) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const coords = pixelToLatLng(px, py, centerLat, centerLng, zoom, rect.width, rect.height)
      setSelectionStart(coords)
      setSelectionEnd(coords)
      selectionDragRef.current = true
      return
    }

    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startCenterLat: centerLat,
      startCenterLng: centerLng,
      hasMoved: false,
    }
  }, [centerLat, centerLng, zoom, isSelectingArea])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // ── Area selection drag: update rectangle endpoint ──
    if (isSelectingArea && selectionDragRef.current) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const coords = pixelToLatLng(px, py, centerLat, centerLng, zoom, rect.width, rect.height)
      setSelectionEnd(coords)
      return
    }

    if (!dragRef.current.isDragging) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect   = canvas.getBoundingClientRect()
      const px     = e.clientX - rect.left
      const py     = e.clientY - rect.top
      const coords = pixelToLatLng(px, py, centerLat, centerLng, zoom, rect.width, rect.height)
      setCursorLat(coords.lat)
      setCursorLng(coords.lng)
      return
    }

    const deltaX = e.clientX - dragRef.current.startX
    const deltaY = e.clientY - dragRef.current.startY

    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      dragRef.current.hasMoved = true
    }

    const scale      = Math.pow(2, zoom)
    const lngPerPx   = 360 / (TILE_SIZE * scale)
    const latPerPx   = lngPerPx * Math.cos((centerLat * Math.PI) / 180)

    const newCenterLng = dragRef.current.startCenterLng - deltaX * lngPerPx
    const newCenterLat = dragRef.current.startCenterLat + deltaY * latPerPx

    setCenterLat(clamp(newCenterLat, -85, 85))
    setCenterLng(((newCenterLng + 180) % 360 + 360) % 360 - 180)
  }, [centerLat, centerLng, zoom, isSelectingArea])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)

    // ── Area selection: finish drawing rectangle ──
    if (isSelectingArea && selectionDragRef.current) {
      selectionDragRef.current = false
      // Selection rectangle is now defined by selectionStart → selectionEnd.
      // TODO: Validate selected area size and show download/explore actions.
      log.info('Area selection complete', {
        start: selectionStart ? `${selectionStart.lat.toFixed(4)},${selectionStart.lng.toFixed(4)}` : 'null',
        end: selectionEnd ? `${selectionEnd.lat.toFixed(4)},${selectionEnd.lng.toFixed(4)}` : 'null',
      })
      return
    }

    if (dragRef.current.isDragging && !dragRef.current.hasMoved) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect   = canvas.getBoundingClientRect()
      const px     = e.clientX - rect.left
      const py     = e.clientY - rect.top
      const coords = pixelToLatLng(px, py, centerLat, centerLng, zoom, rect.width, rect.height)

      log.info('Map tap → setting explore location', {
        lat: coords.lat.toFixed(5),
        lng: coords.lng.toFixed(5),
      })
      setExploreLocation(coords.lat, coords.lng)
      setShowTapHint(false)
    }

    dragRef.current.isDragging = false
  }, [centerLat, centerLng, zoom, setExploreLocation, isSelectingArea, selectionStart, selectionEnd])

  // ── Scroll Zoom ───────────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.5 : 0.5
    setZoom((z: number) => {
      const newZ = clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
      log.debug('Map zoom', { from: z, to: newZ })
      return newZ
    })
  }, [])

  // ── Pinch Zoom (2-finger) ──────────────────────────────────────────────────
  // Two-finger pinch zooms the map tiles (not the whole page).
  // touch-action: none on the canvas CSS prevents the browser from
  // intercepting the gesture. The handlers below detect 2-finger pinch
  // start/move/end and apply logarithmic zoom to the tile level.
  //
  // NOTE: React touch events are used here (not pointer events) because
  // pointer events don't easily expose multi-touch finger distances.
  // The canvas CSS `touch-action: none` ensures these events fire reliably.

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const dx   = e.touches[0].clientX - e.touches[1].clientX
      const dy   = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      pinchRef.current = { isPinching: true, startDist: dist, startZoom: zoom }
    }
  }, [zoom])

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current.isPinching) {
      e.preventDefault()
      const dx    = e.touches[0].clientX - e.touches[1].clientX
      const dy    = e.touches[0].clientY - e.touches[1].clientY
      const dist  = Math.sqrt(dx * dx + dy * dy)
      const scale = dist / pinchRef.current.startDist
      setZoom(clamp(
        pinchRef.current.startZoom + Math.log2(scale),
        MAP_MIN_ZOOM,
        MAP_MAX_ZOOM,
      ))
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    pinchRef.current.isPinching = false
  }, [])

  // ── Zoom buttons ──────────────────────────────────────────────────────────────

  const handleZoomIn  = () => setZoom((z) => clamp(Math.floor(z) + 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  const handleZoomOut = () => setZoom((z) => clamp(Math.ceil(z)  - 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))

  /**
   * GPS crosshair button handler.
   * Centers the map on GPS AND switches SCAN/EXPLORE to use GPS as viewpoint.
   * If GPS hasn't been requested yet, prompts the browser for permission.
   * TODO: Show a brief toast/snackbar if GPS permission is denied.
   * TODO: Animate map pan to GPS position instead of instant jump.
   */
  const dismissGpsPrompt = useCallback(() => {
    setGpsPrompt(null)
    if (gpsPromptTimerRef.current) {
      clearTimeout(gpsPromptTimerRef.current)
      gpsPromptTimerRef.current = null
    }
  }, [])

  const showGpsPromptTimed = useCallback((prompt: 'denied' | 'unavailable') => {
    setGpsPrompt(prompt)
    if (gpsPromptTimerRef.current) clearTimeout(gpsPromptTimerRef.current)
    gpsPromptTimerRef.current = setTimeout(() => setGpsPrompt(null), 6000)
  }, [])

  const handleMyLocation = useCallback(async () => {
    log.info('My Location tapped', { gpsPermission, hasGPS: gpsLat !== null })

    // Already denied — show the denial message with instructions
    if (gpsPermission === 'denied') {
      showGpsPromptTimed('denied')
      return
    }

    // GPS API not available on this device/browser
    if (gpsPermission === 'unavailable') {
      showGpsPromptTimed('unavailable')
      return
    }

    // First time — show a brief prompt explaining what we need, then request
    if (gpsPermission === 'unknown') {
      setGpsPrompt('needs-permission')
      await requestGPS()
      // Check the result after the browser prompt resolves
      const state = useLocationStore.getState()
      if (state.gpsPermission === 'denied') {
        showGpsPromptTimed('denied')
        return
      }
      if (state.gpsPermission === 'unavailable') {
        showGpsPromptTimed('unavailable')
        return
      }
      // Permission granted — dismiss prompt and proceed
      dismissGpsPrompt()
    }

    // Switch to GPS mode — sets GPS as active viewpoint for SCAN/EXPLORE
    switchToGPS()

    // Center map on GPS position
    const state = useLocationStore.getState()
    if (state.gpsLat !== null && state.gpsLng !== null) {
      setCenterLat(state.gpsLat)
      setCenterLng(state.gpsLng)
    }
  }, [switchToGPS, gpsLat, gpsPermission, requestGPS, showGpsPromptTimed, dismissGpsPrompt])

  // Compute canvas opacities from zoom
  const gOpacity = globeOpacity(zoom)
  const fOpacity = 1 - gOpacity

  return (
    <div className={styles.screen}>
      {/* Three.js globe canvas — behind the flat DEM canvas */}
      <canvas
        ref={globeCanvasRef}
        className={styles.globeCanvas}
        style={{ opacity: gOpacity, pointerEvents: gOpacity >= 0.5 ? 'auto' : 'none' }}
        onPointerDown={handleGlobePointerDown}
        onPointerMove={handleGlobePointerMove}
        onPointerUp={handleGlobePointerUp}
        onPointerCancel={handleGlobePointerUp}
        onWheel={handleGlobeWheel}
        onTouchStart={handleGlobeTouchStart}
        onTouchMove={handleGlobeTouchMove}
        onTouchEnd={handleGlobeTouchEnd}
        aria-hidden={gOpacity === 0}
      />

      {/* DEM canvas — flat map, on top of globe */}
      <canvas
        ref={canvasRef}
        className={styles.mapCanvas}
        style={{ opacity: fOpacity, pointerEvents: gOpacity < 0.5 ? 'auto' : 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        role="application"
        aria-label="Elevation map — drag to pan, scroll to zoom, tap to explore"
      />

      {/* Loading indicator */}
      <div
        className={`${styles.tileLoadingIndicator} ${isLoading ? styles.loading : ''}`}
        aria-hidden="true"
      />

      {/* Location banner — shows active viewpoint with color-coded state.
          Teal = user tapped a point on the map ("Selected Location").
          Blue = GPS is the active viewpoint ("My Location").
          Always visible so users know what SCAN/EXPLORE are pointed at. */}
      <div
        className={`${styles.locationBanner} ${mode === 'exploring' ? styles.bannerExplore : styles.bannerGps}`}
        role="status"
      >
        <div className={styles.bannerDot} aria-hidden="true" />
        <div>
          <div className={styles.bannerLabel}>
            {mode === 'exploring' ? 'SELECTED LOCATION' : 'MY LOCATION'}
          </div>
          <div className={styles.bannerCoords}>
            {activeLat.toFixed(4)}°, {activeLng.toFixed(4)}°
          </div>
        </div>
      </div>

      {/* GPS permission prompt — appears when user taps "My Location" without permission.
          Three states: needs-permission (brief "allow location" note before browser prompt),
          denied (instructions to enable in browser settings), unavailable (not supported). */}
      {gpsPrompt && (
        <div className={styles.gpsPrompt} role="alert">
          <div className={styles.gpsPromptContent}>
            {gpsPrompt === 'needs-permission' && (
              <>
                <div className={styles.gpsPromptIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="2" x2="12" y2="6" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="6" y2="12" />
                    <line x1="18" y1="12" x2="22" y2="12" />
                  </svg>
                </div>
                <div className={styles.gpsPromptText}>
                  <strong>Location access needed</strong>
                  <span>Allow location to center the map on your position</span>
                </div>
              </>
            )}
            {gpsPrompt === 'denied' && (
              <>
                <div className={`${styles.gpsPromptIcon} ${styles.gpsPromptIconDenied}`}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                </div>
                <div className={styles.gpsPromptText}>
                  <strong>Location access denied</strong>
                  <span>Enable location in your browser settings to use this feature</span>
                </div>
              </>
            )}
            {gpsPrompt === 'unavailable' && (
              <>
                <div className={`${styles.gpsPromptIcon} ${styles.gpsPromptIconDenied}`}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                </div>
                <div className={styles.gpsPromptText}>
                  <strong>Location not available</strong>
                  <span>GPS is not supported on this device or browser</span>
                </div>
              </>
            )}
          </div>
          {gpsPrompt !== 'needs-permission' && (
            <button
              className={styles.gpsPromptDismiss}
              onClick={dismissGpsPrompt}
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Map controls — zoom slider + location + area selection */}
      <div className={styles.controls}>
        <button className={styles.controlBtn} onClick={handleZoomIn}  aria-label="Zoom in">+</button>
        <div className={styles.zoomSliderWrap}>
          <input
            type="range"
            className={styles.zoomSlider}
            min={MAP_MIN_ZOOM}
            max={MAP_MAX_ZOOM}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            aria-label="Zoom level"
          />
        </div>
        <button className={styles.controlBtn} onClick={handleZoomOut} aria-label="Zoom out">−</button>
        <button
          className={`${styles.controlBtn} ${styles.locationBtn} ${gpsLat !== null ? styles.locationActive : ''}`}
          onClick={handleMyLocation}
          aria-label="Center on my GPS location"
          title="My Location"
        >
          {/* Crosshair icon — standard "locate me" symbol */}
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="9" cy="9" r="4" />
            <line x1="9" y1="1" x2="9" y2="4" />
            <line x1="9" y1="14" x2="9" y2="17" />
            <line x1="1" y1="9" x2="4" y2="9" />
            <line x1="14" y1="9" x2="17" y2="9" />
          </svg>
        </button>
        {/* Area selection toggle — enters rectangle drawing mode for EXPLORE. */}
        <button
          className={`${styles.controlBtn} ${styles.selectAreaBtn} ${isSelectingArea ? styles.selectAreaActive : ''}`}
          onClick={() => {
            if (isSelectingArea) {
              // Exit selection mode — clear the drawn rectangle
              setIsSelectingArea(false)
              setSelectionStart(null)
              setSelectionEnd(null)
            } else {
              setIsSelectingArea(true)
            }
          }}
          aria-label={isSelectingArea ? 'Cancel area selection' : 'Select area on map'}
          title={isSelectingArea ? 'Cancel Selection' : 'Select Area'}
        >
          {/* Rectangle icon — represents area selection */}
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="12" height="12" strokeDasharray="3 2" />
            <rect x="1.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="13.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="1.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="13.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {/* Area selection overlay — instructions, dimensions, and EXPLORE action.
          Drag-select is for EXPLORE only. Offline downloads use predetermined
          regions in Settings (curated for correct size + accurate estimates). */}
      {isSelectingArea && (
        <div className={`${styles.selectionOverlay} ${selectionDims ? styles[`selection_${selectionSeverity}`] : ''}`} role="status">
          {selectionStart && selectionEnd && selectionDims ? (
            <>
              <div className={styles.selectionHint}>
                {selectionSeverity === 'danger'
                  ? 'AREA TOO LARGE — REDUCE SELECTION'
                  : selectionSeverity === 'warning'
                  ? 'LARGE AREA — MAY BE SLOW ON MOBILE'
                  : 'DRAG TO ADJUST SELECTION'}
              </div>
              <div className={styles.selectionDims}>
                {formatDistance(selectionDims.widthKm, units)} × {formatDistance(selectionDims.heightKm, units)}
              </div>
              <button
                className={`${styles.controlBtn} ${styles.selectionActionBtn} ${selectionSeverity === 'danger' ? styles.selectionActionDisabled : ''}`}
                onClick={() => {
                  if (selectionSeverity === 'danger') return
                  log.info('Explore area selected', {
                    start: `${selectionStart.lat.toFixed(4)},${selectionStart.lng.toFixed(4)}`,
                    end: `${selectionEnd.lat.toFixed(4)},${selectionEnd.lng.toFixed(4)}`,
                    dims: `${selectionDims.widthKm.toFixed(0)}×${selectionDims.heightKm.toFixed(0)} km`,
                    tiles: selectionDims.tileCount,
                  })
                  // TODO: Load selected bounds in EXPLORE screen —
                  // create a dynamic region from selectionStart/selectionEnd,
                  // call terrainStore.loadRegion() with the custom bounds,
                  // then navigate to the explore screen via uiStore.setActiveScreen('explore').
                }}
                aria-label="Open selected area in Explore 3D view"
                disabled={selectionSeverity === 'danger'}
              >
                EXPLORE IN 3D
              </button>
            </>
          ) : (
            <div className={styles.selectionHint}>
              SELECT AREA TO EXPLORE IN 3D
            </div>
          )}
        </div>
      )}

      {/* Tap hint — brief instruction for first-time users.
          Fades after first interaction. Not a full tutorial — just enough
          to get started. */}
      <div
        className={`${styles.tapHint} ${!showTapHint ? styles.hidden : ''}`}
        aria-hidden="true"
      >
        Tap to explore · Pinch to zoom · Drag to pan
      </div>

      {/* Globe debug toggle */}
      <button
        className={styles.globeDebugToggle}
        onClick={() => setShowGlobeDebug((v) => !v)}
        aria-label="Toggle globe debug panel"
        style={{ opacity: gOpacity > 0 || showGlobeDebug ? 1 : 0.3 }}
      >
        {showGlobeDebug ? '✕' : '⊙'}
      </button>

      {/* Globe debug panel */}
      {showGlobeDebug && (() => {
        const camZ = zoomToCameraZ(zoom)
        const gOp = globeOpacity(zoom)

        // Globe scale: degrees per pixel at center of visible face
        const globeCanvas = globeCanvasRef.current
        const viewH = globeCanvas ? globeCanvas.clientHeight : 700
        const globeDegPerPx = camZ * 2 * Math.tan(22.5 * Math.PI / 180) / viewH * (180 / Math.PI)

        // Globe equivalent flat zoom
        const equivZ = globeEquivFlatZoom(camZ, viewH)
        // Effective tile zoom during transition (blended)
        let effectiveZ = zoom
        if (gOp > 0 && gOp < 1) {
          effectiveZ = equivZ + (1 - gOp) * (zoom - equivZ)
        }
        const effectiveTileZ = Math.max(2, Math.round(effectiveZ))

        // Flat map scale: degrees per pixel at tileZoom
        const flatDegPerPx = 360 / (TILE_SIZE * Math.pow(2, effectiveTileZ))

        // Globe visible arc
        const visibleArcDeg = camZ > 1 ? 2 * Math.asin(1 / camZ) * (180 / Math.PI) : 180
        const globeFillsScreen = visibleArcDeg > 45

        const scaleRatio = globeDegPerPx / flatDegPerPx

        return (
        <div className={styles.globeDebug} style={{ top: 78 }}>
          <strong>Globe Debug</strong><br />
          Mode: {gOpacity > 0 ? (fOpacity > 0 ? 'TRANSITION' : 'GLOBE') : 'FLAT MAP'}<br />
          Zoom: {zoom.toFixed(2)} · Tile Z: {effectiveTileZ} {gOp > 0 && gOp < 1 ? `(equiv z${equivZ.toFixed(1)})` : ''}<br />
          Globe α: {gOpacity.toFixed(2)} · Flat α: {fOpacity.toFixed(2)} (cos ease)<br />
          Transition: ≤{GLOBE_FULL_ZOOM} globe → {GLOBE_FULL_ZOOM}–{GLOBE_GONE_ZOOM} crossfade → ≥{GLOBE_GONE_ZOOM} flat<br />
          Camera Z: {camZ.toFixed(2)} · Pointer: {gOpacity >= 0.5 ? 'GLOBE' : 'FLAT'}<br />
          <strong>── Alignment ──</strong><br />
          Flat center: {centerLat.toFixed(4)}°, {centerLng.toFixed(4)}°<br />
          Globe: {globeDegPerPx.toFixed(4)}°/px · Flat: {flatDegPerPx.toFixed(4)}°/px<br />
          Ratio: {scaleRatio.toFixed(2)}× (1.0 = match)<br />
          Globe arc: {visibleArcDeg.toFixed(0)}° of 45° FOV · {globeFillsScreen ? 'FILLS screen' : 'visible edge'}<br />
          <strong>Texture</strong><br />
          Globe tex: {globeTextureZoom !== null ? `z${globeTextureZoom}` : 'loading...'} · UV: Mercator (1−V)<br />
          Material: MeshBasic (unlit)<br />
          {globeTilesTotal > 0 && globeTilesLoaded < globeTilesTotal && (
            <>Tiles loading: {globeTilesLoaded}/{globeTilesTotal}<br /></>
          )}
          Globe ready: {globeReady ? 'yes' : 'no'}<br />
          <strong>Scene</strong><br />
          Atmos: r=1.06 BackSide · Fresnel p=3.0<br />
          Render: on-demand · Frames: {globeRenderCountRef.current}<br />
          Sphere: 96×96 segments<br />
          {threeRef.current && (() => {
            const rx = threeRef.current.earth.rotation.x
            const ry = threeRef.current.earth.rotation.y
            const facing = sphereRotationToLatLng(rx, ry)
            const dLat = facing.lat - centerLat
            const dLng = facing.lng - centerLng
            return (<>
              <strong>── Globe Source ──</strong><br />
              Globe center: {facing.lat.toFixed(4)}°, {facing.lng.toFixed(4)}°<br />
              Raw rotation: x={rx.toFixed(4)} y={ry.toFixed(4)}<br />
              Formula: lng = −90 − rotY×(180/π)<br />
              <strong>── Active Location ──</strong><br />
              Dot: {activeLat.toFixed(4)}°, {activeLng.toFixed(4)}° ({mode})<br />
              {gpsLat !== null && <>GPS: {gpsLat.toFixed(4)}°, {gpsLng!.toFixed(4)}°<br /></>}
              <strong style={{ color: (Math.abs(dLat) > 0.5 || Math.abs(dLng) > 0.5) ? '#ff4444' : '#44ff44' }}>
                ── Sync ──</strong><br />
              Flat↔Globe: Δlat={dLat.toFixed(2)}° Δlng={dLng.toFixed(2)}°<br />
            </>)
          })()}
          <strong>Flat Map</strong><br />
          Draw: {lastFlatMapDrawRef.current} (#{flatMapDrawCountRef.current})<br />
          Skip: {globeOpacity(zoom) >= 1 ? 'YES (globe α=1)' : 'no'}<br />
          Debounce: 120ms
        </div>
        )
      })()}

      {/* Coordinate bar */}
      <div className={styles.coordBar} aria-label="Map coordinates">
        <span className={styles.coordText}>
          {formatCoordinates(cursorLat, cursorLng, coordFormat)}
        </span>
        <span className={styles.zoomText}>Z{Math.round(zoom)}</span>
      </div>
    </div>
  )
}

// ─── Elevation Legend ─────────────────────────────────────────────────────────

/**
 * Draws a compact elevation legend in the bottom-left corner.
 * Gradient bar showing the full ocean-depth color ramp from low (dark) to high (bright).
 */
function drawElevationLegend(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const navH   = 64   // approximate nav bar height (px) — legend sits above it
  const barH   = 100
  const barW   = 10
  const x      = 14
  const y      = H - navH - barH - 40
  const labelX = x + barW + 8

  // Gradient bar: dark at bottom, bright at top
  const grad = ctx.createLinearGradient(0, y + barH, 0, y)
  grad.addColorStop(0,    'rgb(  0,  8, 16)')   // sea level
  grad.addColorStop(0.2,  'rgb( 14, 57, 81)')   // 1000m
  grad.addColorStop(0.4,  'rgb( 18, 75,107)')   // 2000m
  grad.addColorStop(0.6,  'rgb( 47,109,135)')   // 4000m
  grad.addColorStop(0.8,  'rgb( 75,142,163)')   // 5000m
  grad.addColorStop(1.0,  'rgb(132,209,219)')   // 7000m

  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fillRect(x - 4, y - 16, barW + 60, barH + 30)

  ctx.fillStyle = grad
  ctx.fillRect(x, y, barW, barH)

  ctx.strokeStyle = 'rgba(132, 209, 219, 0.3)'
  ctx.lineWidth   = 0.5
  ctx.strokeRect(x, y, barW, barH)

  ctx.font      = `9px 'Josefin Sans', sans-serif`
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(167, 221, 229, 0.8)'

  ctx.fillText('HIGH', labelX, y + 8)
  ctx.fillText('LOW',  labelX, y + barH)

  ctx.restore()
}

export default MapScreen
