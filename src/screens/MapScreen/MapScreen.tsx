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
import { useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import {
  DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM,
  MAP_MIN_ZOOM, MAP_MAX_ZOOM, TILE_SIZE,
  MAP_LABEL_TILE_URL, MAP_TILE_SUBDOMAINS,
} from '../../core/constants'
import {
  latLngToTile, tileToLatLng, latLngToPixel, pixelToLatLng,
  clamp, formatCoordinates,
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

// ─── Main Component ────────────────────────────────────────────────────────────

const MapScreen: React.FC = () => {
  const { activeLat, activeLng, gpsLat, gpsLng, mode, setExploreLocation, switchToGPS } = useLocationStore()
  const { peaks, meshData, activeRegion } = useTerrainStore()
  const { coordFormat, showPeakLabels } = useSettingsStore()

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [centerLat, setCenterLat] = useState(DEFAULT_MAP_CENTER.lat)
  const [centerLng, setCenterLng] = useState(DEFAULT_MAP_CENTER.lng)
  const [zoom, setZoom]           = useState(DEFAULT_MAP_ZOOM)
  const [isLoading, setIsLoading] = useState(false)
  const [showTapHint, setShowTapHint] = useState(true)

  const [cursorLat, setCursorLat] = useState(DEFAULT_MAP_CENTER.lat)
  const [cursorLng, setCursorLng] = useState(DEFAULT_MAP_CENTER.lng)

  const dragRef = useRef({
    isDragging: false,
    startX: 0, startY: 0,
    startCenterLat: DEFAULT_MAP_CENTER.lat,
    startCenterLng: DEFAULT_MAP_CENTER.lng,
    hasMoved: false,
  })

  const pinchRef    = useRef({ isPinching: false, startDist: 0, startZoom: DEFAULT_MAP_ZOOM })
  const loadingRef  = useRef(0)

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

    const ctx = canvas.getContext('2d')
    if (!ctx) { log.error('Canvas 2D context unavailable'); return }

    const W = canvas.width
    const H = canvas.height

    const thisGeneration = ++loadingRef.current

    log.debug('Drawing DEM map', { W, H, zoom, center: `${centerLat.toFixed(4)},${centerLng.toFixed(4)}` })

    // Dark ocean base — fills any gaps between tiles while loading
    ctx.fillStyle = '#000810'
    ctx.fillRect(0, 0, W, H)

    // ── Calculate tile range ────────────────────────────────────────────────
    const tileCountX = Math.ceil(W / TILE_SIZE) + 2
    const tileCountY = Math.ceil(H / TILE_SIZE) + 2

    const centerTile    = latLngToTile(centerLat, centerLng, zoom)
    const centerTileTopLeft = tileToLatLng(centerTile.x, centerTile.y, zoom)
    const centerTilePixel = latLngToPixel(
      centerTileTopLeft.lat, centerTileTopLeft.lng,
      centerLat, centerLng, zoom, W, H,
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
        const maxTile  = Math.pow(2, zoom)
        const wrappedX = ((tileX % maxTile) + maxTile) % maxTile
        if (tileY < 0 || tileY >= maxTile) continue

        const tileTL    = tileToLatLng(wrappedX, tileY, zoom)
        const tilePixel = latLngToPixel(
          tileTL.lat, tileTL.lng,
          centerLat, centerLng, zoom, W, H,
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
      loadDEMTile(zoom, wrappedX, tileY)
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
      loadLabelTile(zoom, wrappedX, tileY)
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
      const nw = latLngToPixel(bounds.north, bounds.west, centerLat, centerLng, zoom, W, H)
      const se = latLngToPixel(bounds.south, bounds.east, centerLat, centerLng, zoom, W, H)

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

    // ── GPS dot ─────────────────────────────────────────────────────────────
    if (gpsLat !== null && gpsLng !== null) {
      const gpsPx = latLngToPixel(gpsLat, gpsLng, centerLat, centerLng, zoom, W, H)
      if (gpsPx.x >= 0 && gpsPx.x <= W && gpsPx.y >= 0 && gpsPx.y <= H) {
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 12, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(132, 209, 219, 0.2)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 6, 0, Math.PI * 2)
        ctx.fillStyle  = '#84D1DB'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur  = 8
        ctx.fill()
        ctx.shadowBlur  = 0
      }
    }

    // ── Explore location marker ──────────────────────────────────────────────
    if (mode === 'exploring') {
      const explorePx = latLngToPixel(activeLat, activeLng, centerLat, centerLng, zoom, W, H)
      if (explorePx.x >= 0 && explorePx.x <= W && explorePx.y >= 0 && explorePx.y <= H) {
        // Outer halo
        ctx.beginPath()
        ctx.arc(explorePx.x, explorePx.y, 12, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(132, 209, 219, 0.2)'
        ctx.fill()
        // Inner dot — matches EXPLORE screen pin color
        ctx.beginPath()
        ctx.arc(explorePx.x, explorePx.y, 6, 0, Math.PI * 2)
        ctx.fillStyle   = '#84D1DB'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur  = 8
        ctx.fill()
        ctx.shadowBlur  = 0
      }
    }

    // ── Peak markers ─────────────────────────────────────────────────────────
    if (showPeakLabels && zoom >= 8) {
      ctx.font      = `bold 11px 'Josefin Sans', sans-serif`
      ctx.textAlign = 'center'

      for (const peak of peaks.slice(0, 20)) {
        const px = latLngToPixel(peak.lat, peak.lng, centerLat, centerLng, zoom, W, H)
        if (px.x < -20 || px.x > W + 20 || px.y < -20 || px.y > H + 20) continue

        ctx.fillStyle   = '#A7DDE5'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur  = 4
        ctx.fillText('▲', px.x, px.y)
        ctx.shadowBlur  = 0

        if (zoom >= 10) {
          ctx.font      = `10px 'Josefin Sans', sans-serif`
          ctx.fillStyle = 'rgba(167, 221, 229, 0.9)'
          ctx.fillText(peak.name, px.x, px.y + 14)
        }
      }
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
  }, [centerLat, centerLng, zoom, gpsLat, gpsLng, activeLat, activeLng, mode, peaks, showPeakLabels, activeRegion, meshData])

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

  useEffect(() => {
    drawMap()
  }, [drawMap])

  // ── Pointer Handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startCenterLat: centerLat,
      startCenterLng: centerLng,
      hasMoved: false,
    }
  }, [centerLat, centerLng])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
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
  }, [centerLat, centerLng, zoom])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)

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
  }, [centerLat, centerLng, zoom, setExploreLocation])

  // ── Scroll Zoom ───────────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -1 : 1
    setZoom((z) => {
      const newZ = clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
      log.debug('Map zoom', { from: z, to: newZ })
      return newZ
    })
  }, [])

  // ── Pinch Zoom ────────────────────────────────────────────────────────────────

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

  const handleMyLocation = useCallback(() => {
    log.info('My Location tapped')
    switchToGPS()
    if (gpsLat !== null && gpsLng !== null) {
      setCenterLat(gpsLat)
      setCenterLng(gpsLng)
    }
  }, [switchToGPS, gpsLat, gpsLng])

  return (
    <div className={styles.screen}>
      {/* DEM canvas */}
      <canvas
        ref={canvasRef}
        className={styles.mapCanvas}
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

      {/* Explore mode banner */}
      {mode === 'exploring' && (
        <div className={styles.exploreBanner} role="status">
          <div>
            <div className={styles.exploreBannerText}>● EXPLORING</div>
            <div className={styles.exploreSubText}>
              {activeLat.toFixed(4)}°, {activeLng.toFixed(4)}°
            </div>
          </div>
          <button
            className={styles.myLocationBtn}
            onClick={handleMyLocation}
            aria-label="Return to my GPS location"
          >
            ← MY LOCATION
          </button>
        </div>
      )}

      {/* Map controls */}
      <div className={styles.controls}>
        <button className={styles.controlBtn} onClick={handleZoomIn}  aria-label="Zoom in">+</button>
        <button className={styles.controlBtn} onClick={handleZoomOut} aria-label="Zoom out">−</button>
        {gpsLat !== null && (
          <button
            className={styles.controlBtn}
            onClick={handleMyLocation}
            aria-label="Center on my location"
            title="My Location"
          >
            ◎
          </button>
        )}
      </div>

      {/* Tap hint */}
      <div
        className={`${styles.tapHint} ${!showTapHint ? styles.hidden : ''}`}
        aria-hidden="true"
      >
        Tap anywhere to explore that terrain
      </div>

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
