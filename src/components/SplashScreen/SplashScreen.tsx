/**
 * EarthContours — Splash Screen
 *
 * Shows for SPLASH_DURATION_MS (2400ms) when the app first loads.
 * During this time, terrain data loads in the background.
 *
 * The progress bar animates from 0 to 100% over the splash duration.
 * It doesn't necessarily reflect real loading progress — it's a UX
 * affordance to let the user know something is happening.
 */

import React, { useEffect, useState } from 'react'
import { useUIStore, useSettingsStore, useTerrainStore } from '../../store'
import { createLogger } from '../../core/logger'
import { SPLASH_DURATION_MS, DEFAULT_REGION_ID } from '../../core/constants'
import styles from './SplashScreen.module.css'

const log = createLogger('COMPONENT:SPLASH')

const SplashScreen: React.FC = () => {
  const setSplashComplete = useUIStore((state) => state.setSplashComplete)
  const initializeLayout = useUIStore((state) => state.initializeLayout)
  const defaultRegionId = useSettingsStore((state) => state.defaultRegionId)
  const loadRegion = useTerrainStore((state) => state.loadRegion)
  const loadingMessage = useTerrainStore((state) => state.loadingMessage)

  const [progress, setProgress] = useState(0)
  const [isFadingOut, setIsFadingOut] = useState(false)

  useEffect(() => {
    log.info('Splash screen mounted', { splashDuration: SPLASH_DURATION_MS })

    // Start loading terrain data immediately while splash shows
    const regionToLoad = defaultRegionId || DEFAULT_REGION_ID
    log.info('Starting background terrain load', { region: regionToLoad })
    loadRegion(regionToLoad).catch((err) => {
      log.error('Background terrain load failed', err)
      // Non-fatal — app will continue, terrain will show error state
    })

    // Initialize layout (preview mode vs mobile) ONCE here
    initializeLayout()

    // Animate progress bar over the splash duration
    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        // Slow down near 90% — real loading might take longer
        const increment = prev < 70 ? 3 : prev < 88 ? 1 : 0.3
        return Math.min(prev + increment, 92)
      })
    }, 80)

    // After splash duration, start fade out then complete
    const splashTimer = setTimeout(() => {
      log.info('Splash duration complete — fading out...')
      setProgress(100)
      setIsFadingOut(true)

      // Wait for fade animation to complete before hiding
      setTimeout(() => {
        log.info('Splash fade complete — app ready')
        setSplashComplete()
      }, 400)  // matches CSS animation duration
    }, SPLASH_DURATION_MS)

    return () => {
      clearInterval(progressInterval)
      clearTimeout(splashTimer)
      log.debug('Splash screen cleanup')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally run once

  log.debug('Splash render', { progress: progress.toFixed(0), isFadingOut })

  return (
    <div
      className={`${styles.splash} ${isFadingOut ? styles.fadeOut : ''}`}
      role="status"
      aria-label="Loading EarthContours"
      aria-live="polite"
    >
      {/* Logo area */}
      <div className={styles.logoArea}>
        <img
          src="/Favicon3.svg"
          alt="Earth Contours logo"
          className={styles.logoImage}
          width="96"
          height="96"
        />
        <div className={styles.appName}>Earth Contours</div>
        <div className={styles.tagline}>Terrain Visualization</div>
      </div>

      {/* Loading progress */}
      <div className={styles.loadingSection}>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className={styles.loadingText}>
          {loadingMessage || 'Initializing...'}
        </div>
      </div>

      <div className={styles.version}>v1.0 MVP</div>
    </div>
  )
}

export default SplashScreen
