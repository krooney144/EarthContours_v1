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
import { useLocationStore, useTerrainStore, useSettingsStore, useUIStore, useMapViewStore } from '../../store'
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
import { loadNaturalEarthRivers, loadNaturalEarthLakes, loadNaturalEarthGlaciers, loadNaturalEarthCoastlines } from '../../data/geoManager'
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

/** Zoom thresholds for globe / flat map crossfade.
 *  Quick clean cut — narrow window so the user zooms through it fast,
 *  like Apple/Google Maps where the 3D→2D switch takes < 1 second. */
const GLOBE_FULL_ZOOM = 5.5    // Globe fully visible at zoom <= 5.5
const GLOBE_GONE_ZOOM = 6.3    // Globe fully hidden at zoom >= 6.3

/** Compute globe opacity from current zoom with steep ease-in-out.
 *  0.8-level window — a single pinch/scroll tick crosses most of it.
 *  Uses smoothstep (Hermite) for a fast mid-transition. */
function globeOpacity(zoom: number): number {
  if (zoom <= GLOBE_FULL_ZOOM) return 1
  if (zoom >= GLOBE_GONE_ZOOM) return 0
  const t = (zoom - GLOBE_FULL_ZOOM) / (GLOBE_GONE_ZOOM - GLOBE_FULL_ZOOM)
  // Hermite smoothstep — steeper through the middle than cosine
  return 1 - (t * t * (3 - 2 * t))
}


/** Compute the effective zoom for flat map rendering and drag sensitivity.
 *  Returns the display zoom directly — the globe camera is now corrected to match
 *  Mercator scale (via GLOBE_CAMERA_ZOOM_BOOST in zoomToCameraZ), so the flat map
 *  no longer needs a perspective offset. This keeps effectiveFlatZoom monotonically
 *  increasing with displayZoom (no more wrong-direction pixel scaling). */
function effectiveFlatZoom(displayZoom: number, _viewHeight: number): number {
  return displayZoom
}

/** Zoom boost for globe camera to compensate for sphere foreshortening.
 *  The theoretical Mercator-match formula is correct at the sub-camera point,
 *  but averaged across the visible area the sphere appears less magnified due
 *  to surface curvature. Adding 0.4 zoom levels brings the globe camera ~32%
 *  closer, making the globe's visible scale match the flat Mercator map's scale
 *  at the same slider zoom. This eliminates the scale jump during crossfade. */
const GLOBE_CAMERA_ZOOM_BOOST = 0.4

/** Map zoom level to camera Z distance from globe center.
 *
 * Derives camera distance so that at the sub-camera point, the globe's
 * degrees-per-pixel matches a Mercator flat map at the same zoom level.
 * Includes GLOBE_CAMERA_ZOOM_BOOST to compensate for sphere foreshortening
 * so the apparent scale matches the flat map during crossfade.
 *
 * Math: At distance d from sphere center (radius 1), 1 radian of arc
 * subtends 1/(d-1) units in view space. Combined with FOV 45° and viewport
 * height, we match the Mercator scale: degPerPx = 360 / (256 * 2^zoom).
 *
 * For low zooms the formula is clamped so the globe stays within the viewport.
 */
function zoomToCameraZ(zoom: number, viewHeight: number = 700): number {
  const correctedZoom = zoom + GLOBE_CAMERA_ZOOM_BOOST
  const degPerPx = 360 / (TILE_SIZE * Math.pow(2, correctedZoom))
  const radPerPx = degPerPx * Math.PI / 180
  const halfFov = (45 / 2) * Math.PI / 180  // FOV = 45°
  const d = 1 + radPerPx * viewHeight / (2 * Math.tan(halfFov))
  return clamp(d, 1.12, 12.0)
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
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 40 + Math.random() * 20
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  // Fixed screen-space size so stars are always visible regardless of distance
  const material = new THREE.PointsMaterial({
    color: 0xe8f0ff,
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
  })
  return new THREE.Points(geometry, material)
}

// ─── Atmosphere Glow (Fresnel BackSide Mesh) ────────────────────────────────

/**
 * Atmosphere halo — a Fresnel shader on a slightly larger sphere rendered with
 * THREE.BackSide. Only the inner face of the atmosphere sphere is visible, and
 * the Earth mesh (r=1.0) naturally occludes the front via the depth buffer.
 * Result: glow is ONLY visible at the limb (edge) where the atmosphere sphere
 * extends past the Earth — proper planetary atmosphere rendering.
 */
function createAtmosphereMesh(): THREE.Mesh {
  const atmosGeo = new THREE.SphereGeometry(1.04, 64, 64)
  const atmosMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorldPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPosition = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float rim = 1.0 - abs(dot(viewDir, vNormal));
        float glow = pow(rim, 3.0) * uIntensity;
        gl_FragColor = vec4(uColor, glow);
      }
    `,
    uniforms: {
      uColor: { value: new THREE.Vector3(0.35, 0.78, 0.88) },  // teal, matching ec-glow
      uIntensity: { value: 1.4 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  return new THREE.Mesh(atmosGeo, atmosMat)
}

// ─── Scale Bar Helpers ────────────────────────────────────────────────────────

/** "Nice" scale bar distances in km, ascending. Pick the one that gives 60–250px. */
const SCALE_STEPS_KM = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
const SCALE_STEPS_MI = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]

/** Compute scale bar width and label for a given pixels-per-km.
 *  Returns null if no step fits in 50-250px range. */
function computeScaleBar(
  pxPerKm: number,
  unitSystem: string,
): { widthPx: number; label: string } | null {
  const steps = unitSystem === 'imperial' ? SCALE_STEPS_MI : SCALE_STEPS_KM
  const kmFactor = unitSystem === 'imperial' ? 1.60934 : 1 // convert step to km for px calc
  for (const step of steps) {
    const km = step * kmFactor
    const px = km * pxPerKm
    if (px >= 50 && px <= 250) {
      const label = unitSystem === 'imperial' ? `${step} mi` : `${step} km`
      return { widthPx: px, label }
    }
  }
  // Fallback: use the first step that's at least 20px
  for (const step of steps) {
    const km = step * kmFactor
    const px = km * pxPerKm
    if (px >= 20) {
      const label = unitSystem === 'imperial' ? `${step} mi` : `${step} km`
      return { widthPx: Math.min(px, 300), label }
    }
  }
  return null
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface MapScreenProps {
  exhibitMode?: boolean
}

const MapScreen: React.FC<MapScreenProps> = ({ exhibitMode = false }) => {
  const { activeLat, activeLng, gpsLat, gpsLng, gpsPermission, mode, setExploreLocation, switchToGPS, requestGPS } = useLocationStore()
  const { peaks, waterBodies, rivers, glaciers, coastlines, meshData, activeRegion, isCustomBounds, setWaterBodies, setRivers, setGlaciers, setCoastlines, loadCustomBounds } = useTerrainStore()
  const { coordFormat, showPeakLabels, showLakes, showRivers: showRiversSetting, showGlaciers, showCoastlines, units } = useSettingsStore()
  const { navigateTo } = useUIStore()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const globeCanvasRef = useRef<HTMLCanvasElement>(null)

  const centerLat = useMapViewStore((s) => s.centerLat)
  const centerLng = useMapViewStore((s) => s.centerLng)
  const zoom = useMapViewStore((s) => s.zoom)
  const setCenterLat = useMapViewStore((s) => s.setCenterLat)
  const setCenterLng = useMapViewStore((s) => s.setCenterLng)
  const setZoom = useMapViewStore((s) => s.setZoom)
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

  // Track active touch count on globe canvas — used to suppress rotation during pinch
  const globeTouchCountRef = useRef(0)

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
    touchStartedAt: 0,  // Timestamp for pinch debounce — don't pan until 80ms elapsed
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

    // Use integer zoom for tile fetching — tiles only exist at integer levels.
    // But use fractional effZoom for all POSITIONING so the map scales smoothly
    // between integer tile levels (sub-tile scaling, like Google/Apple Maps).
    const effZoom = effectiveFlatZoom(zoom, H)
    const tileZoom = Math.max(2, Math.round(effZoom))
    const subTileScale = Math.pow(2, effZoom - tileZoom)  // >1 when between integer levels going up, <1 going down
    const displayTileSize = TILE_SIZE * subTileScale

    log.debug('Drawing DEM map', { W, H, zoom, effZoom: effZoom.toFixed(2), tileZoom, subTileScale: subTileScale.toFixed(3), center: `${centerLat.toFixed(4)},${centerLng.toFixed(4)}` })

    // Dark ocean base — fills any gaps between tiles while loading
    ctx.fillStyle = '#000810'
    ctx.fillRect(0, 0, W, H)

    // ── Calculate tile range ────────────────────────────────────────────────
    // Use displayTileSize so we fetch enough tiles when sub-tile scale < 1
    const tileCountX = Math.ceil(W / displayTileSize) + 2
    const tileCountY = Math.ceil(H / displayTileSize) + 2

    const centerTile    = latLngToTile(centerLat, centerLng, tileZoom)
    // centerTilePixel not used directly — tile positions computed individually below

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

        // Position using fractional effZoom for smooth sub-tile scaling.
        // Tile lat/lng is computed at integer tileZoom (where the tile exists),
        // but latLngToPixel uses effZoom so the position scales continuously.
        const tileTL    = tileToLatLng(wrappedX, tileY, tileZoom)
        const tilePixel = latLngToPixel(
          tileTL.lat, tileTL.lng,
          centerLat, centerLng, effZoom, W, H,
        )
        tileJobs.push({
          wrappedX,
          tileY,
          pixelX: Math.round(tilePixel.x),
          pixelY: Math.round(tilePixel.y),
        })
      }
    }

    // ── Pass 0: Progressive placeholder — draw cached lower-zoom tiles scaled up ──
    // Like Google Maps: show a blurry version instantly, then sharpen as real tiles arrive.
    // For each tile position, walk down from (tileZoom-1) to max(tileZoom-4, 2) looking
    // for a cached parent tile. If found, compute the sub-region and draw it scaled up.
    if (tileZoom >= 5) {
      for (const { wrappedX, tileY, pixelX, pixelY } of tileJobs) {
        // Already cached at target zoom? Skip placeholder.
        if (demTileCache.has(`${tileZoom}/${wrappedX}/${tileY}`)) continue

        for (let fallbackZ = tileZoom - 1; fallbackZ >= Math.max(tileZoom - 4, 2); fallbackZ--) {
          const zoomDiff = tileZoom - fallbackZ
          const scale = 1 << zoomDiff  // 2, 4, 8, 16
          // Parent tile coords: integer-divide by scale
          const parentX = wrappedX >> zoomDiff
          const parentY = tileY >> zoomDiff
          const parentKey = `${fallbackZ}/${parentX}/${parentY}`
          const cached = demTileCache.get(parentKey)
          if (!cached) continue

          // Sub-region within the parent tile
          const subX = (wrappedX % scale) * (TILE_SIZE / scale)
          const subY = (tileY % scale) * (TILE_SIZE / scale)
          const subSize = TILE_SIZE / scale

          ctx.drawImage(
            cached,
            subX, subY, subSize, subSize,     // source rect within parent
            pixelX, pixelY, displayTileSize + 1, displayTileSize + 1, // +1px overlap to hide sub-pixel seams
          )
          break
        }
      }
    }

    // ── Pass 1: DEM elevation tiles (high-res, overwrites placeholders) ──────
    await Promise.all(tileJobs.map(({ wrappedX, tileY, pixelX, pixelY }) =>
      loadDEMTile(tileZoom, wrappedX, tileY)
        .then((tileCanvas) => {
          if (thisGeneration !== loadingRef.current) return
          ctx.drawImage(tileCanvas, pixelX, pixelY, displayTileSize + 1, displayTileSize + 1)
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
          ctx.drawImage(img, pixelX, pixelY, displayTileSize + 1, displayTileSize + 1)
        })
        .catch(() => {
          // Label tiles are optional — silent fail if CDN is unavailable
        }),
    ))
    if (thisGeneration !== loadingRef.current) return

    // ── Loaded region border ───────────────────────────────────────────────
    if (activeRegion && meshData) {
      const { bounds } = activeRegion
      const nw = latLngToPixel(bounds.north, bounds.west, centerLat, centerLng, effZoom, W, H)
      const se = latLngToPixel(bounds.south, bounds.east, centerLat, centerLng, effZoom, W, H)

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
        ctx.fillText('▣ 3D EXPLORE VIEW', rx + 6, ry + 15)
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
      const gpsPx = latLngToPixel(gpsLat, gpsLng, centerLat, centerLng, effZoom, W, H)
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

      const dotPx = latLngToPixel(dotLat, dotLng, centerLat, centerLng, effZoom, W, H)
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

    // ── Water body polygons (Natural Earth, filtered by scalerank + zoom) ────
    // z6: scalerank ≤ 3 (major lakes)
    // z7: scalerank ≤ 6
    // z8-9: scalerank ≤ 8
    // z10+: all lakes
    if (showLakes && waterBodies.length > 0 && tileZoom >= 6) {
      const maxScalerank = tileZoom <= 6 ? 3 : tileZoom <= 7 ? 6 : tileZoom <= 9 ? 8 : 99
      const minPts = tileZoom <= 9 ? 10 : 4

      for (let wbIdx = 0; wbIdx < waterBodies.length; wbIdx++) {
        const wb = waterBodies[wbIdx]
        if ((wb.scalerank ?? 10) > maxScalerank) continue
        const pts = wb.polygon
        if (pts.length < minPts) continue

        // Quick cull: check if center is remotely near viewport
        const cp = latLngToPixel(wb.center.lat, wb.center.lng, centerLat, centerLng, effZoom, W, H)
        if (cp.x < -500 || cp.x > W + 500 || cp.y < -500 || cp.y > H + 500) continue

        // Draw outer polygon + inner rings (islands) using evenodd fill rule
        ctx.beginPath()
        const first = latLngToPixel(pts[0].lat, pts[0].lng, centerLat, centerLng, effZoom, W, H)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < pts.length; i++) {
          const p = latLngToPixel(pts[i].lat, pts[i].lng, centerLat, centerLng, effZoom, W, H)
          ctx.lineTo(p.x, p.y)
        }
        ctx.closePath()

        // Inner rings (islands/holes) — drawn in same path for evenodd cutout
        if (wb.innerRings) {
          for (const ring of wb.innerRings) {
            if (ring.length < 4) continue
            const rf = latLngToPixel(ring[0].lat, ring[0].lng, centerLat, centerLng, effZoom, W, H)
            ctx.moveTo(rf.x, rf.y)
            for (let i = 1; i < ring.length; i++) {
              const p = latLngToPixel(ring[i].lat, ring[i].lng, centerLat, centerLng, effZoom, W, H)
              ctx.lineTo(p.x, p.y)
            }
            ctx.closePath()
          }
        }

        // Semi-transparent blue fill with thin outline — evenodd cuts out islands
        ctx.fillStyle   = 'rgba(30, 90, 160, 0.35)'
        ctx.fill('evenodd')
        ctx.strokeStyle = 'rgba(70, 140, 210, 0.6)'
        ctx.lineWidth   = 1
        ctx.stroke()

        // Label whenever the lake is visible — size scales with zoom
        if (wb.name) {
          const fontSize = tileZoom <= 8 ? 9 : tileZoom <= 10 ? 10 : 12
          ctx.font      = `${fontSize}px 'Josefin Sans', sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = 'rgba(120, 190, 240, 0.85)'
          ctx.fillText(wb.name, cp.x, cp.y)
        }
      }
    }

    // ── River lines (Natural Earth, filtered by scalerank + zoom) ──────────
    // z6: scalerank ≤ 3 (major rivers)
    // z7: scalerank ≤ 6
    // z8-9: scalerank ≤ 8
    // z10+: all rivers including streams
    // Line thickness scales with zoom for visual weight.
    if (showRiversSetting && rivers.length > 0 && tileZoom >= 6) {
      const maxScalerank = tileZoom <= 6 ? 3 : tileZoom <= 7 ? 6 : tileZoom <= 9 ? 8 : 99

      ctx.lineJoin    = 'round'
      ctx.lineCap     = 'round'

      for (let rIdx = 0; rIdx < rivers.length; rIdx++) {
        const river = rivers[rIdx]
        const sr = river.scalerank ?? 10
        if (sr > maxScalerank) continue

        const pts = river.points
        if (pts.length < 2) continue

        // Quick cull: check midpoint
        const midIdx = Math.floor(pts.length / 2)
        const mp = latLngToPixel(pts[midIdx].lat, pts[midIdx].lng, centerLat, centerLng, effZoom, W, H)
        if (mp.x < -500 || mp.x > W + 500 || mp.y < -500 || mp.y > H + 500) continue

        // Line thickness scales: major rivers thicker, zoom adds weight
        const zoomScale = 0.8 + (tileZoom - 6) * 0.15
        if (river.isStream) {
          ctx.strokeStyle = 'rgba(50, 120, 200, 0.3)'
          ctx.lineWidth   = 0.8 * zoomScale
        } else if (sr <= 3) {
          ctx.strokeStyle = 'rgba(50, 120, 200, 0.6)'
          ctx.lineWidth   = 2.0 * zoomScale
        } else {
          ctx.strokeStyle = 'rgba(50, 120, 200, 0.45)'
          ctx.lineWidth   = 1.2 * zoomScale
        }

        ctx.beginPath()
        const first = latLngToPixel(pts[0].lat, pts[0].lng, centerLat, centerLng, effZoom, W, H)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < pts.length; i++) {
          const p = latLngToPixel(pts[i].lat, pts[i].lng, centerLat, centerLng, effZoom, W, H)
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()

        // Label whenever the river is visible — size scales with zoom
        if (river.name) {
          const fontSize = tileZoom <= 8 ? 8 : tileZoom <= 10 ? 9 : 11
          ctx.font      = `italic ${fontSize}px 'Josefin Sans', sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = 'rgba(100, 170, 230, 0.8)'
          ctx.fillText(river.name, mp.x, mp.y - 4)
        }
      }
    }

    // ── Glacier polygons (Natural Earth, filtered by scalerank + zoom) ──────
    // z6: scalerank ≤ 1 (ice sheets + ice caps)
    // z7: scalerank ≤ 3
    // z8-9: scalerank ≤ 6
    // z10+: all glaciers
    if (showGlaciers && glaciers.length > 0 && tileZoom >= 6) {
      const maxScalerank = tileZoom <= 6 ? 1 : tileZoom <= 7 ? 3 : tileZoom <= 9 ? 6 : 99

      for (let gIdx = 0; gIdx < glaciers.length; gIdx++) {
        const gl = glaciers[gIdx]
        if (gl.scalerank > maxScalerank) continue
        const pts = gl.polygon
        if (pts.length < 4) continue

        const cp = latLngToPixel(gl.center.lat, gl.center.lng, centerLat, centerLng, effZoom, W, H)
        if (cp.x < -500 || cp.x > W + 500 || cp.y < -500 || cp.y > H + 500) continue

        ctx.beginPath()
        const first = latLngToPixel(pts[0].lat, pts[0].lng, centerLat, centerLng, effZoom, W, H)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < pts.length; i++) {
          const p = latLngToPixel(pts[i].lat, pts[i].lng, centerLat, centerLng, effZoom, W, H)
          ctx.lineTo(p.x, p.y)
        }
        ctx.closePath()

        if (gl.innerRings) {
          for (const ring of gl.innerRings) {
            if (ring.length < 4) continue
            const rf = latLngToPixel(ring[0].lat, ring[0].lng, centerLat, centerLng, effZoom, W, H)
            ctx.moveTo(rf.x, rf.y)
            for (let i = 1; i < ring.length; i++) {
              const p = latLngToPixel(ring[i].lat, ring[i].lng, centerLat, centerLng, effZoom, W, H)
              ctx.lineTo(p.x, p.y)
            }
            ctx.closePath()
          }
        }

        ctx.fillStyle   = 'rgba(200, 220, 240, 0.25)'
        ctx.fill('evenodd')
        ctx.strokeStyle = 'rgba(180, 210, 240, 0.5)'
        ctx.lineWidth   = 0.8
        ctx.stroke()

        // Label whenever the glacier is visible — size scales with zoom
        if (gl.name) {
          const fontSize = tileZoom <= 9 ? 8 : tileZoom <= 11 ? 9 : 11
          ctx.font      = `${fontSize}px 'Josefin Sans', sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = 'rgba(200, 220, 240, 0.75)'
          ctx.fillText(gl.name, cp.x, cp.y)
        }
      }
    }

    // ── Coastlines (Natural Earth, filtered by scalerank + zoom) ────────────
    // z6: scalerank ≤ 1 (major continental coastlines)
    // z7: scalerank ≤ 3
    // z8-9: scalerank ≤ 5
    // z10+: all coastlines
    if (showCoastlines && coastlines.length > 0 && tileZoom >= 6) {
      const maxScalerank = tileZoom <= 6 ? 1 : tileZoom <= 7 ? 3 : tileZoom <= 9 ? 5 : 99
      const zoomScale = 0.6 + (tileZoom - 6) * 0.1

      ctx.lineJoin = 'round'
      ctx.lineCap  = 'round'

      for (let cIdx = 0; cIdx < coastlines.length; cIdx++) {
        const coast = coastlines[cIdx]
        if (coast.scalerank > maxScalerank) continue

        const pts = coast.points
        if (pts.length < 2) continue

        // Quick cull: check midpoint
        const midIdx = Math.floor(pts.length / 2)
        const mp = latLngToPixel(pts[midIdx].lat, pts[midIdx].lng, centerLat, centerLng, effZoom, W, H)
        if (mp.x < -500 || mp.x > W + 500 || mp.y < -500 || mp.y > H + 500) continue

        ctx.strokeStyle = 'rgba(140, 180, 160, 0.6)'
        ctx.lineWidth   = 1.0 * zoomScale

        ctx.beginPath()
        const first = latLngToPixel(pts[0].lat, pts[0].lng, centerLat, centerLng, effZoom, W, H)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < pts.length; i++) {
          const p = latLngToPixel(pts[i].lat, pts[i].lng, centerLat, centerLng, effZoom, W, H)
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
      }
    }

    // ── Peak markers ─────────────────────────────────────────────────────────
    if (showPeakLabels && tileZoom >= 8) {
      ctx.font      = `bold 11px 'Josefin Sans', sans-serif`
      ctx.textAlign = 'center'

      for (const peak of peaks.slice(0, 20)) {
        const px = latLngToPixel(peak.lat, peak.lng, centerLat, centerLng, effZoom, W, H)
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
      const startPx = latLngToPixel(selectionStart.lat, selectionStart.lng, centerLat, centerLng, effZoom, W, H)
      const endPx   = latLngToPixel(selectionEnd.lat, selectionEnd.lng, centerLat, centerLng, effZoom, W, H)

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
  }, [centerLat, centerLng, zoom, gpsLat, gpsLng, activeLat, activeLng, mode, peaks, showPeakLabels, waterBodies, rivers, glaciers, coastlines, showLakes, showRiversSetting, showGlaciers, showCoastlines, activeRegion, meshData, selectionStart, selectionEnd, isSelectingArea, selectionSeverity, selectionDims, units])

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

  // ── Natural Earth geo data (static GeoJSON, cached in IndexedDB) ──
  // Loads once on mount, cached forever after first fetch.
  useEffect(() => {
    if (showLakes || showRiversSetting || showGlaciers || showCoastlines) {
      if (showRiversSetting && rivers.length === 0) {
        loadNaturalEarthRivers().then(setRivers).catch((err) => log.warn('Failed to load rivers', err))
      }
      if (showLakes && waterBodies.length === 0) {
        loadNaturalEarthLakes().then(setWaterBodies).catch((err) => log.warn('Failed to load lakes', err))
      }
      if (showGlaciers && glaciers.length === 0) {
        loadNaturalEarthGlaciers().then(setGlaciers).catch((err) => log.warn('Failed to load glaciers', err))
      }
      if (showCoastlines && coastlines.length === 0) {
        loadNaturalEarthCoastlines().then(setCoastlines).catch((err) => log.warn('Failed to load coastlines', err))
      }
    }
  }, [showLakes, showRiversSetting, showGlaciers, showCoastlines, rivers.length, waterBodies.length, glaciers.length, coastlines.length, setRivers, setWaterBodies, setGlaciers, setCoastlines])

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
    camera.position.set(0, 0, zoomToCameraZ(zoom, canvas.clientHeight || 700))

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

    // Atmosphere glow — Fresnel BackSide mesh slightly larger than Earth.
    // Only the limb (edge) glows because the Earth sphere occludes the front.
    const atmosphere = createAtmosphereMesh()
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

        // Upgrade to z=4 in background — 256 tiles, 4096×4096.
        // Keeps globe sharp at zoom 5-6 where z3 gets blurry.
        buildGlobeTexture(4, (loaded, total) => {
          setGlobeTilesLoaded(loaded)
          setGlobeTilesTotal(total)
        }).then((tex4) => {
          if (!threeRef.current) return
          const t4 = new THREE.CanvasTexture(tex4)
          t4.colorSpace = THREE.SRGBColorSpace
          threeRef.current.earthMaterial.map = t4
          threeRef.current.earthMaterial.needsUpdate = true
          setGlobeTextureZoom(4)
          requestGlobeRenderRef.current()
          log.info('Globe z4 texture applied (upgrade)')
        }).catch((err) => {
          log.warn('Globe z4 texture failed, staying on z3', err)
        })

        // Pre-cache z4 flat map tiles around center for smooth transition.
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
        const atmosMesh = threeRef.current.atmosphere
        ;(atmosMesh.material as THREE.ShaderMaterial).dispose()
        atmosMesh.geometry.dispose()
      }
      threeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Sync globe camera Z and rotation from zoom/center ─────────────────────

  useEffect(() => {
    const t = threeRef.current
    if (!t) return
    const viewH = globeCanvasRef.current?.clientHeight || 700
    t.camera.position.z = zoomToCameraZ(zoom, viewH)
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
    const viewH = globeCanvasRef.current?.clientHeight || 700
    const camZ = zoomToCameraZ(zoom, viewH)
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
    // Suppress drag/rotation when 2+ fingers are active (pinch gesture)
    if (globeTouchCountRef.current >= 2) return
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
    // Suppress rotation when 2+ fingers are active (pinch gesture)
    if (globeTouchCountRef.current >= 2) return

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

    // Gentle zoom-dependent rotation sensitivity.
    // 0.005 at zoom ≤2 (original feel), lerp down to 0.002 at zoom 5.5+.
    // Keeps low-zoom navigation unchanged, tames high-zoom exaggeration.
    const rotScale = zoom <= 2 ? 0.005
      : zoom >= 5.5 ? 0.002
      : 0.005 - (zoom - 2) * (0.003 / 3.5)  // linear 0.005→0.002 over zoom 2→5.5
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

  // Globe wheel zoom — smooth fractional steps (0.3 per tick for smooth feel)
  const handleGlobeWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.3 : 0.3
    const z = useMapViewStore.getState().zoom
    setZoom(clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  }, [setZoom])

  // Globe pinch zoom — finger-anchored (Apple Maps style)
  const globePinchRef = useRef({
    isPinching: false,
    startDist: 0,
    startZoom: DEFAULT_MAP_ZOOM,
    anchorLat: 0,
    anchorLng: 0,
    centerX: 0,
    centerY: 0,
  })

  const handleGlobeTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    globeTouchCountRef.current = e.touches.length
    if (e.touches.length === 2) {
      // Kill any ongoing rotation momentum
      globeDragRef.current.isDragging = false
      globeDragRef.current.velocityX = 0
      globeDragRef.current.velocityY = 0

      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2

      // Raycast to find the lat/lng under the pinch center
      let anchorLat = 0
      let anchorLng = 0
      if (threeRef.current && globeCanvasRef.current) {
        const canvas = globeCanvasRef.current
        const rect = canvas.getBoundingClientRect()
        const ndcX = ((cx - rect.left) / rect.width) * 2 - 1
        const ndcY = -((cy - rect.top) / rect.height) * 2 + 1
        const raycaster = new THREE.Raycaster()
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), threeRef.current.camera)
        const hits = raycaster.intersectObject(threeRef.current.earth)
        if (hits.length > 0) {
          const localPt = threeRef.current.earth.worldToLocal(hits[0].point.clone())
          anchorLat = Math.asin(clamp(localPt.y, -1, 1)) * (180 / Math.PI)
          anchorLng = Math.atan2(-localPt.z, localPt.x) * (180 / Math.PI)
        }
      }

      globePinchRef.current = {
        isPinching: true,
        startDist: dist,
        startZoom: zoom,
        anchorLat,
        anchorLng,
        centerX: cx,
        centerY: cy,
      }
    }
  }, [zoom])

  const handleGlobeTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    globeTouchCountRef.current = e.touches.length
    if (e.touches.length === 2 && globePinchRef.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const scale = dist / globePinchRef.current.startDist
      const newZoom = clamp(
        globePinchRef.current.startZoom + Math.log2(scale),
        MAP_MIN_ZOOM,
        MAP_MAX_ZOOM,
      )
      setZoom(newZoom)

      // Rotate the globe so the anchor lat/lng stays under the pinch center.
      // Convert anchor lat/lng to the expected globe rotation, then apply.
      const { rotX, rotY } = latLngToSphereRotation(
        globePinchRef.current.anchorLat,
        globePinchRef.current.anchorLng,
      )
      if (threeRef.current) {
        // Smoothly blend toward the anchor position to keep it pinned
        const earth = threeRef.current.earth
        const blendFactor = 0.15
        earth.rotation.x += (rotX - earth.rotation.x) * blendFactor
        earth.rotation.y += (rotY - earth.rotation.y) * blendFactor
        earth.rotation.x = clamp(earth.rotation.x, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05)

        const { lat, lng } = sphereRotationToLatLng(earth.rotation.x, earth.rotation.y)
        setCenterLat(lat)
        setCenterLng(lng)
        requestGlobeRender()
      }
    }
  }, [requestGlobeRender])

  const handleGlobeTouchEnd = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    globeTouchCountRef.current = e.touches?.length || 0
    if (globeTouchCountRef.current < 2) {
      globePinchRef.current.isPinching = false
    }
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
      touchStartedAt: e.pointerType === 'touch' ? Date.now() : 0,
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

    // Pinch debounce: for touch input, suppress pan for first 80ms so a late
    // second finger can trigger pinch instead of causing a pan jump.
    if (dragRef.current.touchStartedAt > 0 && pinchRef.current.isPinching) {
      // Pinch took over — cancel the drag
      dragRef.current.isDragging = false
      return
    }
    if (dragRef.current.touchStartedAt > 0 && Date.now() - dragRef.current.touchStartedAt < 80) {
      return  // Wait for potential second finger
    }

    const deltaX = e.clientX - dragRef.current.startX
    const deltaY = e.clientY - dragRef.current.startY

    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      dragRef.current.hasMoved = true
    }

    // Use effectiveFlatZoom so drag speed matches the rendered tile zoom.
    // During globe→flat transition, raw zoom is higher than the tiles on screen,
    // which makes drag feel sluggish without this correction.
    const canvas = canvasRef.current
    const viewH = canvas ? canvas.clientHeight : 700
    const dragZoom = effectiveFlatZoom(zoom, viewH)
    const scale      = Math.pow(2, dragZoom)
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

  // Flat map wheel zoom — same 0.3/tick as globe for unified feel
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.3 : 0.3
    const z = useMapViewStore.getState().zoom
    const newZ = clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
    log.debug('Map zoom', { from: z, to: newZ })
    setZoom(newZ)
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
      // Cancel any active single-finger drag — pinch takes priority
      dragRef.current.isDragging = false
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

  const handleZoomIn  = () => {
    const z = useMapViewStore.getState().zoom
    setZoom(clamp(Math.floor(z) + 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  }
  const handleZoomOut = () => {
    const z = useMapViewStore.getState().zoom
    setZoom(clamp(Math.ceil(z) - 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  }

  // ── Custom vertical zoom slider ────────────────────────────────────────────
  const zoomTrackRef = useRef<HTMLDivElement>(null)
  const zoomDraggingRef = useRef(false)

  const zoomFromClientY = useCallback((clientY: number) => {
    const track = zoomTrackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    // Top of track = max zoom, bottom = min zoom
    const fraction = 1 - clamp((clientY - rect.top) / rect.height, 0, 1)
    setZoom(MAP_MIN_ZOOM + fraction * (MAP_MAX_ZOOM - MAP_MIN_ZOOM))
  }, [])

  const handleSliderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    zoomDraggingRef.current = true
    zoomFromClientY(e.clientY)
  }, [zoomFromClientY])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomDraggingRef.current) return
    zoomFromClientY(e.clientY)
  }, [zoomFromClientY])

  const handleSliderPointerUp = useCallback(() => {
    zoomDraggingRef.current = false
  }, [])

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
        style={{
          opacity: fOpacity,
          pointerEvents: gOpacity < 0.5 ? 'auto' : 'none',
          filter: gOpacity > 0 ? `brightness(${1 + gOpacity * 0.35})` : 'none',
        }}
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

      {/* In exhibit mode, hide all chrome — B2 control strips handle everything */}
      {!exhibitMode && (<>

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

      {/* Map controls — Google Maps style: location + area on top, then zoom */}
      <div className={styles.controls}>
        <button
          className={`${styles.controlBtn} ${styles.locationBtn} ${gpsLat !== null ? styles.locationActive : ''}`}
          onClick={handleMyLocation}
          aria-label="Center on my GPS location"
          title="My Location"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="9" cy="9" r="4" />
            <line x1="9" y1="1" x2="9" y2="4" />
            <line x1="9" y1="14" x2="9" y2="17" />
            <line x1="1" y1="9" x2="4" y2="9" />
            <line x1="14" y1="9" x2="17" y2="9" />
          </svg>
        </button>
        <button
          className={`${styles.controlBtn} ${styles.selectAreaBtn} ${isSelectingArea ? styles.selectAreaActive : ''}`}
          onClick={() => {
            if (isSelectingArea) {
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
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="12" height="12" strokeDasharray="3 2" />
            <rect x="1.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="13.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="1.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
            <rect x="13.5" y="13.5" width="3" height="3" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button className={styles.controlBtn} onClick={handleZoomIn}  aria-label="Zoom in">+</button>
        {/* Custom vertical zoom slider — div-based for cross-browser reliability */}
        <div
          ref={zoomTrackRef}
          className={styles.zoomTrackContainer}
          onPointerDown={handleSliderPointerDown}
          onPointerMove={handleSliderPointerMove}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
          role="slider"
          aria-label="Zoom level"
          aria-valuemin={MAP_MIN_ZOOM}
          aria-valuemax={MAP_MAX_ZOOM}
          aria-valuenow={Math.round(zoom)}
        >
          <div className={styles.zoomTrack} />
          <div
            className={styles.zoomThumb}
            style={{ top: `${(1 - (zoom - MAP_MIN_ZOOM) / (MAP_MAX_ZOOM - MAP_MIN_ZOOM)) * 100}%` }}
          />
        </div>
        <button className={styles.controlBtn} onClick={handleZoomOut} aria-label="Zoom out">−</button>
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
                  const bounds = {
                    north: Math.max(selectionStart.lat, selectionEnd.lat),
                    south: Math.min(selectionStart.lat, selectionEnd.lat),
                    east:  Math.max(selectionStart.lng, selectionEnd.lng),
                    west:  Math.min(selectionStart.lng, selectionEnd.lng),
                  }
                  log.info('Explore area selected — loading custom bounds', {
                    north: bounds.north.toFixed(4), south: bounds.south.toFixed(4),
                    east: bounds.east.toFixed(4), west: bounds.west.toFixed(4),
                    dims: `${selectionDims.widthKm.toFixed(0)}×${selectionDims.heightKm.toFixed(0)} km`,
                  })
                  // Start loading custom bounds and navigate to EXPLORE
                  loadCustomBounds(bounds)
                  navigateTo('explore')
                  setIsSelectingArea(false)
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
        const viewH = globeCanvasRef.current?.clientHeight || 700
        const viewW = globeCanvasRef.current?.clientWidth || 400
        const camZ = zoomToCameraZ(zoom, viewH)
        const effZ = effectiveFlatZoom(zoom, viewH)
        const tZ = Math.round(effZ)
        const sts = Math.pow(2, effZ - tZ)

        // ── Scale comparison: 300km in pixels for globe vs flat map ──
        const SCALE_KM = 300
        const DEG_PER_KM_LNG = 1 / (111.320 * Math.cos(centerLat * Math.PI / 180))
        const halfDegLng = (SCALE_KM / 2) * DEG_PER_KM_LNG

        // Flat map: use Mercator pixel math at effZoom
        const flatP1 = latLngToPixel(centerLat, centerLng - halfDegLng, centerLat, centerLng, effZ, viewW, viewH)
        const flatP2 = latLngToPixel(centerLat, centerLng + halfDegLng, centerLat, centerLng, effZ, viewW, viewH)
        const flatPx300 = Math.abs(flatP2.x - flatP1.x)

        // Globe: project two points on the sphere through the Three.js camera
        // Uses the earth mesh's actual world matrix so rotation matches exactly.
        let globePx300 = 0
        if (threeRef.current) {
          const cam = threeRef.current.camera
          const earthMesh = threeRef.current.earth
          cam.updateMatrixWorld()
          earthMesh.updateMatrixWorld()

          const toScreen = (lat: number, lng: number) => {
            const latR = lat * Math.PI / 180
            const lngR = lng * Math.PI / 180
            // Same convention as location marker (line 1382-1385)
            const v = new THREE.Vector3(
              Math.cos(latR) * Math.cos(lngR),
              Math.sin(latR),
              -Math.cos(latR) * Math.sin(lngR),
            )
            // Transform through the earth mesh's world matrix (includes rotation)
            v.applyMatrix4(earthMesh.matrixWorld)
            v.project(cam)
            return { x: (v.x + 1) / 2 * viewW, y: (1 - v.y) / 2 * viewH }
          }
          const gP1 = toScreen(centerLat, centerLng - halfDegLng)
          const gP2 = toScreen(centerLat, centerLng + halfDegLng)
          globePx300 = Math.abs(gP2.x - gP1.x)
        }

        return (
          <div className={styles.globeDebug} style={{ top: 78 }}>
            <strong>Map Debug</strong><br />
            Mode: {gOpacity > 0 ? (fOpacity > 0 ? 'TRANSITION' : 'GLOBE') : 'FLAT MAP'} · Zoom: {zoom.toFixed(2)}<br />
            Globe α: {gOpacity.toFixed(2)} · Flat α: {fOpacity.toFixed(2)} · CamZ: {camZ.toFixed(3)}<br />
            Center: {centerLat.toFixed(4)}°, {centerLng.toFixed(4)}°<br />
            <strong>Sub-tile</strong><br />
            EffZoom: {effZ.toFixed(2)} · TileZ: {tZ} · Scale: {sts.toFixed(3)} · Size: {(256 * sts).toFixed(0)}px<br />
            <strong>Transition</strong><br />
            Window: z{GLOBE_FULL_ZOOM}→z{GLOBE_GONE_ZOOM} ({(GLOBE_GONE_ZOOM - GLOBE_FULL_ZOOM).toFixed(1)} levels) · Curve: smoothstep<br />
            Pointer: {gOpacity >= 0.5 ? 'GLOBE' : 'FLAT'} · Brightness: {gOpacity > 0 ? `${(1 + gOpacity * 0.35).toFixed(2)}×` : '1.00×'}<br />
            <strong>Scale ({SCALE_KM}km)</strong><br />
            Globe: {globePx300.toFixed(0)}px · Flat: {flatPx300.toFixed(0)}px · Ratio: {flatPx300 > 0 ? (globePx300 / flatPx300).toFixed(2) : '—'}×<br />
            <strong>Natural Earth</strong><br />
            Lakes: {showLakes ? 'ON' : 'OFF'} ({waterBodies.length}) · Rivers: {showRiversSetting ? 'ON' : 'OFF'} ({rivers.length}) · Glaciers: {showGlaciers ? 'ON' : 'OFF'} ({glaciers.length}) · Coast: {showCoastlines ? 'ON' : 'OFF'} ({coastlines.length})<br />
            <strong>Selection Area</strong><br />
            {selectionStart && selectionEnd ? (() => {
              const n = Math.max(selectionStart.lat, selectionEnd.lat)
              const s = Math.min(selectionStart.lat, selectionEnd.lat)
              const e = Math.max(selectionStart.lng, selectionEnd.lng)
              const w = Math.min(selectionStart.lng, selectionEnd.lng)
              return <>
                NW: {n.toFixed(4)}°, {w.toFixed(4)}°<br />
                NE: {n.toFixed(4)}°, {e.toFixed(4)}°<br />
                SE: {s.toFixed(4)}°, {e.toFixed(4)}°<br />
                SW: {s.toFixed(4)}°, {w.toFixed(4)}°<br />
                {selectionDims && <>Size: {selectionDims.widthKm.toFixed(1)} × {selectionDims.heightKm.toFixed(1)} km</>}
              </>
            })() : 'No selection drawn'}<br />
            <strong>Loaded Region</strong><br />
            {activeRegion ? <>
              {isCustomBounds ? 'Custom' : activeRegion.id}: {activeRegion.bounds.north.toFixed(4)}°N, {activeRegion.bounds.south.toFixed(4)}°S, {activeRegion.bounds.east.toFixed(4)}°E, {activeRegion.bounds.west.toFixed(4)}°W
            </> : 'None'}
          </div>
        )
      })()}

      {/* Scale bar */}
      {(() => {
        const viewH = globeCanvasRef.current?.clientHeight || 700
        const viewW = globeCanvasRef.current?.clientWidth || 400
        const effZ = effectiveFlatZoom(zoom, viewH)
        // Flat map: px per km via Mercator at center lat
        const testKm = 100
        const degLng100 = testKm / (111.320 * Math.cos(centerLat * Math.PI / 180))
        const fP1 = latLngToPixel(centerLat, centerLng - degLng100 / 2, centerLat, centerLng, effZ, viewW, viewH)
        const fP2 = latLngToPixel(centerLat, centerLng + degLng100 / 2, centerLat, centerLng, effZ, viewW, viewH)
        const flatPxPerKm = Math.abs(fP2.x - fP1.x) / testKm

        // Globe: px per km via Three.js projection
        let globePxPerKm = 0
        if (threeRef.current) {
          const cam = threeRef.current.camera
          const earthMesh = threeRef.current.earth
          cam.updateMatrixWorld()
          earthMesh.updateMatrixWorld()
          const latR = centerLat * Math.PI / 180
          const halfDegLng = degLng100 / 2
          const lngR1 = (centerLng - halfDegLng) * Math.PI / 180
          const lngR2 = (centerLng + halfDegLng) * Math.PI / 180
          const v1 = new THREE.Vector3(Math.cos(latR) * Math.cos(lngR1), Math.sin(latR), -Math.cos(latR) * Math.sin(lngR1))
          const v2 = new THREE.Vector3(Math.cos(latR) * Math.cos(lngR2), Math.sin(latR), -Math.cos(latR) * Math.sin(lngR2))
          v1.applyMatrix4(earthMesh.matrixWorld); v1.project(cam)
          v2.applyMatrix4(earthMesh.matrixWorld); v2.project(cam)
          const gPx = Math.abs(((v2.x + 1) / 2 * viewW) - ((v1.x + 1) / 2 * viewW))
          globePxPerKm = gPx / testKm
        }

        // Use globe scale when globe visible, flat when flat visible, blend during transition
        const pxPerKm = gOpacity >= 1 ? globePxPerKm
          : gOpacity <= 0 ? flatPxPerKm
          : globePxPerKm * gOpacity + flatPxPerKm * (1 - gOpacity)

        const bar = computeScaleBar(pxPerKm, units)
        if (!bar) return null

        return (
          <div className={styles.scaleBar} aria-label="Map scale">
            <div className={styles.scaleBarLine} style={{ width: bar.widthPx }} />
            <span className={styles.scaleBarLabel}>{bar.label}</span>
            {showGlobeDebug && gOpacity > 0 && gOpacity < 1 && (
              <span className={styles.scaleBarDebug}>
                G:{globePxPerKm.toFixed(1)}px/km F:{flatPxPerKm.toFixed(1)}px/km
              </span>
            )}
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

      {/* End of non-exhibit chrome */}
      </>)}
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
