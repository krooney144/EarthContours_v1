/**
 * EarthContours — MAP Screen
 *
 * Dark topographic map using Carto Dark Matter tiles rendered on HTML <canvas>.
 * The dark basemap matches the ocean-depth color palette of the rest of the app.
 *
 * Features:
 * - Drag to pan
 * - Scroll wheel / pinch to zoom (zoom levels 4–16)
 * - Click to set explore location (sends that location to SCAN/EXPLORE)
 * - GPS dot at current location
 * - Peak markers (▲) at summit coordinates
 * - Glowing border around any loaded terrain region
 * - Coordinates bar at bottom
 *
 * Tile URL: Carto Dark Matter — dark minimal basemap, free, no API key
 * Attribution: © OpenStreetMap contributors © CARTO
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import {
  DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM,
  MAP_MIN_ZOOM, MAP_MAX_ZOOM, TILE_SIZE,
  MAP_TILE_SUBDOMAINS, MAP_ATTRIBUTION,
} from '../../core/constants'
import {
  latLngToTile, tileToLatLng, latLngToPixel, pixelToLatLng,
  clamp, formatCoordinates,
} from '../../core/utils'
import { TileLoadError } from '../../core/errors'
import type { TileCoord } from '../../core/types'
import styles from './MapScreen.module.css'

const log = createLogger('SCREEN:MAP')

// ─── Tile Cache ────────────────────────────────────────────────────────────────

const tileCache = new Map<string, HTMLImageElement>()
const TILE_CACHE_MAX = 200

function getTileUrl(z: number, x: number, y: number): string {
  // Carto Dark Matter tiles — rotate through a/b/c/d subdomains for parallelism
  const subdomain = MAP_TILE_SUBDOMAINS[(x + y) % MAP_TILE_SUBDOMAINS.length]
  // {r} = '@2x' on retina screens for crisp tiles — empty string on 1x
  const r = window.devicePixelRatio >= 2 ? '@2x' : ''
  return `https://${subdomain}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}${r}.png`
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement> {
  const key = `${z}/${x}/${y}`

  if (tileCache.has(key)) {
    return Promise.resolve(tileCache.get(key)!)
  }

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const url = getTileUrl(z, x, y)
    img.src = url

    img.onload = () => {
      if (tileCache.size >= TILE_CACHE_MAX) {
        const firstKey = tileCache.keys().next().value
        if (firstKey) tileCache.delete(firstKey)
      }
      tileCache.set(key, img)
      log.debug('Tile loaded', { key })
      resolve(img)
    }

    img.onerror = () => {
      const err = new TileLoadError(url)
      log.warn('Tile load failed', { key, url })
      reject(err)
    }
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
  const [zoom, setZoom] = useState(DEFAULT_MAP_ZOOM)
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

  const pinchRef = useRef({ isPinching: false, startDist: 0, startZoom: DEFAULT_MAP_ZOOM })
  const loadingRef = useRef(0)

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

    log.debug('Drawing map', { W, H, zoom, center: `${centerLat.toFixed(4)},${centerLng.toFixed(4)}` })

    // Clear with dark ocean background
    ctx.fillStyle = '#070f18'
    ctx.fillRect(0, 0, W, H)

    // ── Calculate which tiles to draw ──
    const tileCountX = Math.ceil(W / TILE_SIZE) + 2
    const tileCountY = Math.ceil(H / TILE_SIZE) + 2

    const centerTile = latLngToTile(centerLat, centerLng, zoom)
    const centerTileTopLeft = tileToLatLng(centerTile.x, centerTile.y, zoom)
    const centerTilePixel = latLngToPixel(
      centerTileTopLeft.lat, centerTileTopLeft.lng,
      centerLat, centerLng, zoom, W, H,
    )

    const startTileX = centerTile.x - Math.floor(tileCountX / 2)
    const startTileY = centerTile.y - Math.floor(tileCountY / 2)

    setIsLoading(true)
    const tilePromises: Promise<void>[] = []

    for (let ty = 0; ty < tileCountY; ty++) {
      for (let tx = 0; tx < tileCountX; tx++) {
        const tileX = startTileX + tx
        const tileY = startTileY + ty

        const maxTile = Math.pow(2, zoom)
        const wrappedX = ((tileX % maxTile) + maxTile) % maxTile

        if (tileY < 0 || tileY >= maxTile) continue

        const tileLat_tl = tileToLatLng(wrappedX, tileY, zoom)
        const tilePixel = latLngToPixel(
          tileLat_tl.lat, tileLat_tl.lng,
          centerLat, centerLng, zoom, W, H,
        )

        const promise = loadTile(zoom, wrappedX, tileY)
          .then((img) => {
            if (thisGeneration !== loadingRef.current) return
            ctx.drawImage(img, Math.round(tilePixel.x), Math.round(tilePixel.y), TILE_SIZE, TILE_SIZE)
          })
          .catch(() => {
            if (thisGeneration !== loadingRef.current) return
            ctx.fillStyle = '#0a1520'
            ctx.fillRect(Math.round(tilePixel.x), Math.round(tilePixel.y), TILE_SIZE - 1, TILE_SIZE - 1)
          })

        tilePromises.push(promise)
      }
    }

    await Promise.all(tilePromises)
    if (thisGeneration !== loadingRef.current) return

    // ── Draw loaded region border (glowing rectangle) ──
    if (activeRegion && meshData) {
      const { bounds } = activeRegion
      const nw = latLngToPixel(bounds.north, bounds.west, centerLat, centerLng, zoom, W, H)
      const se = latLngToPixel(bounds.south, bounds.east, centerLat, centerLng, zoom, W, H)

      const rx = Math.round(nw.x)
      const ry = Math.round(nw.y)
      const rw = Math.round(se.x - nw.x)
      const rh = Math.round(se.y - nw.y)

      // Outer glow
      ctx.save()
      ctx.shadowColor = 'rgba(132, 209, 219, 0.8)'
      ctx.shadowBlur = 16
      ctx.strokeStyle = 'rgba(132, 209, 219, 0.85)'
      ctx.lineWidth = 2
      ctx.strokeRect(rx, ry, rw, rh)
      // Wide soft halo
      ctx.shadowBlur = 32
      ctx.strokeStyle = 'rgba(132, 209, 219, 0.25)'
      ctx.lineWidth = 8
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.restore()

      // Region name label at the top of the border
      if (rw > 80 && rh > 24) {
        ctx.save()
        ctx.font = `bold 10px 'Josefin Sans', sans-serif`
        ctx.fillStyle = 'rgba(132, 209, 219, 0.9)'
        ctx.textAlign = 'left'
        ctx.shadowColor = 'rgba(132, 209, 219, 0.7)'
        ctx.shadowBlur = 6
        ctx.fillText('▣ ' + activeRegion.name.toUpperCase(), rx + 6, ry + 15)
        ctx.restore()
      }

      log.debug('Region border drawn', { region: activeRegion.id })
    }

    // ── Draw GPS dot ──
    if (gpsLat !== null && gpsLng !== null) {
      const gpsPx = latLngToPixel(gpsLat, gpsLng, centerLat, centerLng, zoom, W, H)
      if (gpsPx.x >= 0 && gpsPx.x <= W && gpsPx.y >= 0 && gpsPx.y <= H) {
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 12, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(132, 209, 219, 0.2)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(gpsPx.x, gpsPx.y, 6, 0, Math.PI * 2)
        ctx.fillStyle = '#84D1DB'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur = 8
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }

    // ── Draw explore location marker ──
    if (mode === 'exploring') {
      const explorePx = latLngToPixel(activeLat, activeLng, centerLat, centerLng, zoom, W, H)
      if (explorePx.x >= 0 && explorePx.x <= W && explorePx.y >= 0 && explorePx.y <= H) {
        ctx.beginPath()
        ctx.arc(explorePx.x, explorePx.y, 8, 0, Math.PI * 2)
        ctx.strokeStyle = '#E6A817'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(explorePx.x, explorePx.y, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#E6A817'
        ctx.fill()
      }
    }

    // ── Draw peak markers ──
    if (showPeakLabels && zoom >= 8) {
      ctx.font = `bold 11px 'Josefin Sans', sans-serif`
      ctx.textAlign = 'center'

      for (const peak of peaks.slice(0, 20)) {
        const px = latLngToPixel(peak.lat, peak.lng, centerLat, centerLng, zoom, W, H)
        if (px.x < -20 || px.x > W + 20 || px.y < -20 || px.y > H + 20) continue

        ctx.fillStyle = '#A7DDE5'
        ctx.shadowColor = '#84D1DB'
        ctx.shadowBlur = 4
        ctx.fillText('▲', px.x, px.y)
        ctx.shadowBlur = 0

        if (zoom >= 10) {
          ctx.font = `10px 'Josefin Sans', sans-serif`
          ctx.fillStyle = 'rgba(167, 221, 229, 0.9)'
          ctx.fillText(peak.name, px.x, px.y + 14)
        }
      }
    }

    // ── Attribution ──
    ctx.font = '10px Arial, sans-serif'
    ctx.fillStyle = 'rgba(240, 248, 255, 0.45)'
    ctx.textAlign = 'right'
    ctx.shadowBlur = 0
    ctx.fillText(MAP_ATTRIBUTION, W - 8, H - 8)

    setIsLoading(false)
    log.debug('Map draw complete')
  }, [centerLat, centerLng, zoom, gpsLat, gpsLng, activeLat, activeLng, mode, peaks, showPeakLabels, activeRegion, meshData])

  // ── Resize observer ─────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        canvas.width = Math.round(width * window.devicePixelRatio)
        canvas.height = Math.round(height * window.devicePixelRatio)
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
        log.debug('Canvas resized', { width, height, dpr: window.devicePixelRatio })
        drawMap()
      }
    })

    observer.observe(canvas)
    return () => observer.disconnect()
  }, [drawMap])

  useEffect(() => {
    drawMap()
  }, [drawMap])

  // ── Pointer Handlers ────────────────────────────────────────────────────────

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
    log.debug('Map drag start', { x: e.clientX, y: e.clientY })
  }, [centerLat, centerLng])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.isDragging) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
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

    const scale = Math.pow(2, zoom)
    const lngPerPx = 360 / (TILE_SIZE * scale)
    const latPerPx = lngPerPx * Math.cos((centerLat * Math.PI) / 180)

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
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const coords = pixelToLatLng(px, py, centerLat, centerLng, zoom, rect.width, rect.height)

      log.info('Map clicked — setting explore location', {
        lat: coords.lat.toFixed(5),
        lng: coords.lng.toFixed(5),
      })

      setExploreLocation(coords.lat, coords.lng)
      setShowTapHint(false)
    }

    dragRef.current.isDragging = false
    log.debug('Map drag end')
  }, [centerLat, centerLng, zoom, setExploreLocation])

  // ── Scroll Zoom ─────────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -1 : 1
    setZoom((z) => {
      const newZ = clamp(z + delta, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
      log.debug('Map zoom changed', { from: z, to: newZ })
      return newZ
    })
  }, [])

  // ── Pinch Zoom ──────────────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      pinchRef.current = { isPinching: true, startDist: dist, startZoom: zoom }
      log.debug('Pinch start', { dist: dist.toFixed(0), zoom })
    }
  }, [zoom])

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const scale = dist / pinchRef.current.startDist
      const newZoom = clamp(
        pinchRef.current.startZoom + Math.log2(scale),
        MAP_MIN_ZOOM,
        MAP_MAX_ZOOM,
      )
      setZoom(newZoom)
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    pinchRef.current.isPinching = false
  }, [])

  // ── Zoom buttons ─────────────────────────────────────────────────────────────

  const handleZoomIn  = () => setZoom((z) => clamp(Math.floor(z) + 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))
  const handleZoomOut = () => setZoom((z) => clamp(Math.ceil(z) - 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM))

  const handleMyLocation = useCallback(() => {
    log.info('My Location button clicked')
    switchToGPS()
    if (gpsLat !== null && gpsLng !== null) {
      setCenterLat(gpsLat)
      setCenterLng(gpsLng)
    }
  }, [switchToGPS, gpsLat, gpsLng])

  return (
    <div className={styles.screen}>
      {/* Map canvas */}
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
        aria-label="Topographic map — drag to pan, scroll to zoom, tap to explore location"
      />

      {/* Tile loading indicator */}
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
        <button className={styles.controlBtn} onClick={handleZoomIn} aria-label="Zoom in">+</button>
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

export default MapScreen
