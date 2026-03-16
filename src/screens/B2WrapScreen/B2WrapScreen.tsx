/**
 * B2 Wrap Screen — 360° Cylindrical Projection Surface
 *
 * Renders a full 360° panorama on a 10880×1080 canvas for cylindrical
 * projection in the B2 venue. South is centered (pixel ~5440), North is
 * split at both edges. East is to the left of South, West to the right.
 *
 * Uses the same skyline worker and rendering pipeline as ScanScreen but
 * with a fixed 360° horizontal FOV and no drag/gyro/zoom interaction.
 *
 * Controls:
 *   - AGL height slider (right edge)
 *   - Coordinate/elevation overlay (bottom center, under North)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCameraStore, useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { MAX_HEIGHT_M, MIN_HEIGHT_M } from '../../core/constants'
import { formatElevation, metersToFeet } from '../../core/utils'
import { fetchPeaksNear } from '../../data/peakLoader'
import type { Peak, SkylineData, RefinedArc, PeakRefineItem } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'
import {
  type CameraParams, type ProjectedBands, type ProjectedRefinedArc,
  type PrebuiltContourStrand, type PeakScreenPos,
  DEG_TO_RAD, EARTH_R, REFRACTION_K, MAX_PEAK_DIST,
  reprojectBands, reprojectRefinedArcs, buildContourStrands,
  project, getHorizonY,
  projectFirstPerson, isPeakVisible,
  skylineAngleAt, bandAngleAt,
  renderTerrain, renderContours,
  drawSkyAndStars, drawHorizonGlow,
} from '../ScanScreen/scanRendererCore'
import styles from './B2WrapScreen.module.css'

const log = createLogger('SCREEN:B2-WRAP')

// ─── Constants ────────────────────────────────────────────────────────────────

/** Native canvas resolution for the cylindrical projection */
const WRAP_W = 10880
const WRAP_H = 1080

/**
 * Fixed camera for 360° panorama:
 * - heading = 180° (looking South) so that South is centered (x = W/2)
 * - pitch = 0 (horizon at vertical center)
 * - hfov = 360 (full panorama)
 *
 * With heading=180, hfov=360:
 *   South (180°) → dBearing = 0, x = W/2. ✓ (center)
 *   West  (270°) → dBearing = 90°, x = W/2 + W/4 = 3W/4. ✓ (right of center)
 *   East  ( 90°) → dBearing = -90°, x = W/2 - W/4 = W/4. ✓ (left of center)
 *   North (  0°) → dBearing = -180°, x = W/2 - W/2 = 0 (left edge)
 *   North (360°) → dBearing = +180°, x = W/2 + W/2 = W (right edge)
 *
 * This places North at both edges — aligning the display seam with the
 * skyline data's natural 0°/360° boundary, which eliminates horizontal
 * line artifacts from contour strands wrapping across the screen.
 */
const WRAP_HEADING = 180
const WRAP_PITCH   = 0
const WRAP_HFOV    = 360

// ─── Component ────────────────────────────────────────────────────────────────

const B2WrapScreen: React.FC = () => {
  const { height_m, setHeightFromSlider } = useCameraStore()
  const { activeLat, activeLng } = useLocationStore()
  const { peaks } = useTerrainStore()
  const { units, showBandLines, showFill, showPeakLabels } = useSettingsStore()

  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const containerRef    = useRef<HTMLDivElement>(null)
  const rafRef          = useRef<number>(0)
  const skylineWorker   = useRef<Worker | null>(null)
  const skylineDataRef  = useRef<SkylineData | null>(null)
  const sliderRef       = useRef<HTMLDivElement>(null)
  const sliderDragRef   = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  const [skylineData, setSkylineData]               = useState<SkylineData | null>(null)
  const [isSkylineComputing, setIsSkylineComputing] = useState(false)
  const [skylineProgress, setSkylineProgress]       = useState(0)
  const [refinedArcs, setRefinedArcs]               = useState<RefinedArc[]>([])
  const [osmPeaks, setOsmPeaks]                     = useState<Peak[]>([])
  const [peakPositions, setPeakPositions]           = useState<PeakScreenPos[]>([])


  const activePeaks: Peak[] = osmPeaks.length > 0 ? osmPeaks : peaks

  // ── Re-projection on AGL change ─────────────────────────────────────────

  const projectedBands = useMemo<ProjectedBands | null>(() => {
    if (!skylineData) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectBands(skylineData, viewerElev)
  }, [skylineData, height_m])

  const contourStrands = useMemo<PrebuiltContourStrand[]>(() => {
    if (!skylineData) return []
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return buildContourStrands(skylineData, viewerElev)
  }, [skylineData, height_m])

  const projectedArcs = useMemo<ProjectedRefinedArc[] | null>(() => {
    if (!skylineData || refinedArcs.length === 0) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectRefinedArcs(refinedArcs, viewerElev)
  }, [skylineData, refinedArcs, height_m])

  const groundElev = skylineData ? skylineData.computedAt.groundElev : 0

  // ── Canvas draw ─────────────────────────────────────────────────────────

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Ensure native resolution
    if (canvas.width !== WRAP_W || canvas.height !== WRAP_H) {
      canvas.width = WRAP_W
      canvas.height = WRAP_H
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)

    const renderScale = 1

    const cam: CameraParams = {
      heading_deg: WRAP_HEADING,
      pitch_deg:   WRAP_PITCH,
      hfov:        WRAP_HFOV,
      W:           WRAP_W,
      H:           WRAP_H,
      scale:       renderScale,
    }

    // 1. Sky + stars
    drawSkyAndStars(ctx, WRAP_W, WRAP_H)

    // 2. Terrain bands (far→near painter's order)
    if (skylineData) {
      renderTerrain(ctx, skylineData, cam, projectedBands, showBandLines, showFill)
    }

    // 3. Contour lines
    if (contourStrands.length > 0 && skylineData) {
      let cElevMin = Infinity, cElevMax = -Infinity
      for (let bi = 0; bi < skylineData.bands.length; bi++) {
        const elev = skylineData.bands[bi].elevations
        for (let i = 0; i < elev.length; i++) {
          if (elev[i] === -Infinity) continue
          if (elev[i] < cElevMin) cElevMin = elev[i]
          if (elev[i] > cElevMax) cElevMax = elev[i]
        }
      }
      renderContours(ctx, contourStrands, cam, cElevMin, cElevMax, skylineData, projectedBands)
    }

    // 4. Horizon glow
    drawHorizonGlow(ctx, cam)

    // 5. Peak dots (all 360°, no FOV filtering — isPeakVisible uses hfov=360)
    const eyeElev = groundElev + height_m
    const newPositions: PeakScreenPos[] = []

    if (skylineData && showPeakLabels) {
      const visiblePeaks = activePeaks.filter(p =>
        isPeakVisible(p, activeLat, activeLng, eyeElev, WRAP_HEADING, WRAP_HFOV, skylineData, projectedBands)
      )
      const topPeaks = visiblePeaks
        .sort((a, b) => b.elevation_m - a.elevation_m)
        .slice(0, 30) // More peaks visible in 360°

      for (const peak of topPeaks) {
        const proj = projectFirstPerson(
          peak.lat, peak.lng, peak.elevation_m,
          activeLat, activeLng, eyeElev, cam,
        )
        if (!proj) continue
        let { screenX, screenY, horizDist } = proj
        if (screenX < -50 || screenX > WRAP_W + 50) continue
        if (horizDist > MAX_PEAK_DIST) continue

        // Snap to ridgeline
        const bearing = ((Math.atan2(
          (peak.lng - activeLng) * 111_320 * Math.cos(activeLat * DEG_TO_RAD),
          (peak.lat - activeLat) * 111_132,
        ) * 180 / Math.PI) + 360) % 360

        const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)
        const peakAngle = Math.atan2(
          peak.elevation_m - (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K) - eyeElev,
          horizDist,
        )

        if (peakAngle <= ridgeAngle + 0.002) {
          // Check per-band for best snap
          let maxBandAngle = -Math.PI / 2
          for (let bi = 0; bi < skylineData.bands.length; bi++) {
            const ba = bandAngleAt(skylineData, bi, bearing, projectedBands)
            if (ba > maxBandAngle) maxBandAngle = ba
          }
          if (maxBandAngle > -Math.PI / 2 + 0.001) {
            const snapped = project(bearing, maxBandAngle, cam)
            if (snapped.y < screenY) screenY = snapped.y
          }
        }

        // Draw peak dot on canvas
        ctx.beginPath()
        ctx.arc(screenX, screenY, 4 * renderScale, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(167, 221, 229, 0.9)'
        ctx.fill()

        // Draw peak name
        ctx.font = `${Math.round(11 * renderScale)}px system-ui, sans-serif`
        ctx.fillStyle = 'rgba(240, 248, 255, 0.85)'
        ctx.textAlign = 'center'
        ctx.fillText(peak.name, screenX, screenY - 10 * renderScale)

        newPositions.push({
          id: `${peak.lat}-${peak.lng}`,
          name: peak.name,
          elevation_m: peak.elevation_m,
          dist_km: horizDist / 1000,
          bearing,
          lat: peak.lat,
          lng: peak.lng,
          screenX,
          screenY,
        })
      }
    }

    setPeakPositions(newPositions)
  }, [
    skylineData, projectedBands, contourStrands, projectedArcs,
    showBandLines, showFill, showPeakLabels,
    activeLat, activeLng, height_m, groundElev, activePeaks,
  ])

  // RAF-gated redraw
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(redrawCanvas)
    return () => cancelAnimationFrame(rafRef.current)
  }, [redrawCanvas])

  // ── Web Worker ──────────────────────────────────────────────────────────

  useEffect(() => {
    const worker = new Worker(
      new URL('../../workers/skylineWorker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type, phase, progress, skyline } = e.data
      if (type === 'progress') {
        if (phase === 'tiles') setSkylineProgress(progress * 0.4)
        else if (phase === 'skyline') setSkylineProgress(0.4 + progress * 0.6)
      } else if (type === 'complete') {
        log.info('Skyline precomputed for B2 Wrap')
        const newSkyline = skyline as SkylineData
        setSkylineData(newSkyline)
        skylineDataRef.current = newSkyline
        setIsSkylineComputing(false)
        setSkylineProgress(1)
        setRefinedArcs([])
      } else if (type === 'refined-arcs') {
        const arcs = e.data.refinedArcs as RefinedArc[]
        log.info('Refined arcs received', { count: arcs.length })
        setRefinedArcs(arcs)
      }
    }

    worker.onerror = (err) => {
      log.warn('Skyline worker error', { err: err.message })
      setIsSkylineComputing(false)
    }

    skylineWorker.current = worker
    return () => { worker.terminate() }
  }, [])

  // ── Skyline computation on location change ──────────────────────────────

  useEffect(() => {
    const prev = skylineDataRef.current
    if (prev) {
      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (activeLng - prev.computedAt.lng) * 111_320 * cosLat
      const dy = (activeLat - prev.computedAt.lat) * 111_132
      if (Math.sqrt(dx * dx + dy * dy) < 1500) return
    }

    const worker = skylineWorker.current
    if (!worker) return

    setIsSkylineComputing(true)
    setSkylineProgress(0)

    worker.postMessage({
      viewerLat:     activeLat,
      viewerLng:     activeLng,
      viewerHeightM: height_m,
      resolution:    4,
      maxRange:      400_000,
    })
  }, [activeLat, activeLng]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch OSM peaks ─────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    fetchPeaksNear(activeLat, activeLng, 130).then(fetchedPeaks => {
      if (!cancelled && fetchedPeaks.length > 0) {
        setOsmPeaks(fetchedPeaks)
        log.info('OSM peaks loaded for B2 Wrap', { count: fetchedPeaks.length })
      }
    })
    return () => { cancelled = true }
  }, [activeLat, activeLng])

  // ── Peak refinement (second pass) ───────────────────────────────────────

  useEffect(() => {
    if (!skylineData || isSkylineComputing || activePeaks.length === 0) return
    const worker = skylineWorker.current
    if (!worker) return

    const eyeElev = skylineData.computedAt.groundElev + height_m
    const refineItems: PeakRefineItem[] = []

    for (const peak of activePeaks) {
      if (!isPeakVisible(peak, activeLat, activeLng, eyeElev, WRAP_HEADING, WRAP_HFOV, skylineData, projectedBands)) continue

      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (peak.lng - activeLng) * 111_320 * cosLat
      const dy = (peak.lat - activeLat) * 111_132
      const dist = Math.sqrt(dx * dx + dy * dy)
      const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

      let bandIndex = -1
      for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
        const cfg = DEPTH_BANDS[bi]
        if (cfg && dist >= cfg.minDist && dist <= cfg.maxDist) {
          bandIndex = bi
          break
        }
      }
      if (bandIndex < 0) continue

      refineItems.push({ bearing, distance: dist, bandIndex, name: peak.name })
    }

    if (refineItems.length === 0) return
    log.info('Requesting peak refinement', { peaks: refineItems.length })
    worker.postMessage({ type: 'refine-peaks', peaks: refineItems })
  }, [skylineData, activePeaks, isSkylineComputing, projectedBands, height_m]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Height slider handlers ──────────────────────────────────────────────

  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    sliderDragRef.current = { isDragging: true, startY: e.clientY, startHeight: height_m }
  }, [height_m])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sliderDragRef.current.isDragging) return
    const track = sliderRef.current
    if (!track) return
    const trackHeight = track.getBoundingClientRect().height
    const deltaY = sliderDragRef.current.startY - e.clientY
    const range = MAX_HEIGHT_M - MIN_HEIGHT_M
    const newHeight = Math.max(MIN_HEIGHT_M, Math.min(MAX_HEIGHT_M,
      sliderDragRef.current.startHeight + (deltaY / trackHeight) * range))
    setHeightFromSlider(metersToFeet(newHeight))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback(() => {
    sliderDragRef.current.isDragging = false
  }, [])

  // ── Loading state ───────────────────────────────────────────────────────

  const isLoading = isSkylineComputing

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={styles.screen}>
      <Link to="/" className={styles.backLink}>← Back</Link>

      <div
        ref={containerRef}
        className={styles.canvasContainer}
      >
        <canvas
          ref={canvasRef}
          className={styles.terrainCanvas}
          width={WRAP_W}
          height={WRAP_H}
        />

        {/* Cardinal direction markers */}
        <div className={styles.cardinalMarker} style={{ left: '50%' }}>S</div>
        <div className={styles.cardinalMarker} style={{ left: '75%' }}>W</div>
        <div className={styles.cardinalMarker} style={{ left: '25%' }}>E</div>
        <div className={styles.cardinalMarker} style={{ left: '0%' }}>
          <span className={styles.cardinalSub}>N</span>
        </div>
        <div className={styles.cardinalMarker} style={{ left: '100%' }}>
          <span className={styles.cardinalSub}>N</span>
        </div>

        {/* Loading overlay */}
        {isLoading && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingBar}>
              <div className={styles.loadingFill} style={{ width: `${Math.round(skylineProgress * 100)}%` }} />
            </div>
            <span className={styles.loadingLabel}>
              Computing 360° panorama… {Math.round(skylineProgress * 100)}%
            </span>
          </div>
        )}

        {/* Height slider */}
        <div className={styles.heightSlider}>
          <span className={styles.heightSliderLabel}>HIGH</span>
          <div
            ref={sliderRef}
            className={styles.heightSliderTrack}
            onPointerDown={handleSliderPointerDown}
            onPointerMove={handleSliderPointerMove}
            onPointerUp={handleSliderPointerUp}
            onPointerCancel={handleSliderPointerUp}
            role="slider"
            aria-label="Eye height above ground"
            aria-valuemin={Math.round(metersToFeet(MIN_HEIGHT_M))}
            aria-valuemax={Math.round(metersToFeet(MAX_HEIGHT_M))}
            aria-valuenow={Math.round(metersToFeet(height_m))}
          >
            <div
              className={styles.heightSliderFill}
              style={{ height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            />
            <div
              className={styles.heightSliderThumb}
              style={{ bottom: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            />
          </div>
          <span className={styles.heightSliderLabel}>LOW</span>
          <span className={styles.heightSliderValue}>
            {units === 'imperial'
              ? `${Math.round(metersToFeet(height_m))}ft`
              : `${Math.round(height_m)}m`}
          </span>
        </div>

        {/* Coordinate overlay — bottom center, under South */}
        <div className={styles.coordOverlay}>
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>LAT</span>
            <span className={styles.coordValue}>{activeLat.toFixed(4)}°</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>LONG</span>
            <span className={styles.coordValue}>{Math.abs(activeLng).toFixed(4)}°{activeLng < 0 ? 'W' : 'E'}</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>ELEV</span>
            <span className={styles.coordValue}>{formatElevation(groundElev, units)}</span>
          </div>
          <div className={styles.coordDivider} />
          <div className={styles.coordItem}>
            <span className={styles.coordLabel}>AGL</span>
            <span className={styles.coordValue}>{formatElevation(height_m, units)}</span>
          </div>
          {skylineData && (
            <>
              <div className={styles.coordDivider} />
              <div className={styles.coordItem}>
                <span className={`${styles.coordValue} ${styles.coordReady}`}>360° READY</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default B2WrapScreen
