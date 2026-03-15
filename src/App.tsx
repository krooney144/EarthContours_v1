/**
 * EarthContours — Root Application Component
 *
 * App.tsx is the top-level shell. It:
 * 1. Shows the SplashScreen on first load
 * 2. Manages the preview layout (desktop) vs single-screen (mobile)
 * 3. Renders the active screen with transition animations
 * 4. Wraps each screen in an ErrorBoundary (so crashes are isolated)
 * 5. Shows the Nav bar at the bottom (except in preview mode)
 *
 * The routing system uses Zustand (uiStore) instead of URL routing because:
 * - Native app feel — no URL changes
 * - Custom zoom transitions between screens
 * - Complex state (e.g., 3D camera) persists between screen visits
 *
 * React Router is used ONLY for the 4 B2/dev pages (/b2-wrap, /b2-wrap-v2,
 * /b2-map, /scan2) which need real URLs for venue projection access.
 * The root / route renders the existing Zustand-based app unchanged.
 */

import React, { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useUIStore, useSettingsStore } from './store'
import SplashScreen from './components/SplashScreen'
import Nav from './components/Nav'
import ErrorBoundary from './components/ErrorBoundary'
import PreviewLayout from './components/PreviewLayout'
import ScanScreen from './screens/ScanScreen'
import ExploreScreen from './screens/ExploreScreen'
import MapScreen from './screens/MapScreen'
import SettingsScreen from './screens/SettingsScreen'
import B2WrapScreen from './screens/B2WrapScreen'
import B2WrapV2Screen from './screens/B2WrapV2Screen'
import B2MapScreen from './screens/B2MapScreen'
import Scan2Screen from './screens/Scan2Screen'
import { createLogger, appLog } from './core/logger'
import styles from './App.module.css'

const log = createLogger('APP')

// ─── Screen Registry ──────────────────────────────────────────────────────────

/**
 * Map of screen ID → component.
 * All screens are imported statically (not lazy-loaded) for the MVP.
 * In Session 2, we may use React.lazy() for code-splitting.
 */
const SCREENS: Record<string, React.ReactNode> = {
  scan:     <ScanScreen />,
  explore:  <ExploreScreen />,
  map:      <MapScreen />,
  settings: <SettingsScreen />,
}

// ─── Main App (Zustand-routed) ───────────────────────────────────────────────

const MainApp: React.FC = () => {
  const {
    activeScreen,
    isPreviewMode,
    splashComplete,
    transitionState,
  } = useUIStore()

  const { reduceMotion } = useSettingsStore()

  // ── Side Effects ────────────────────────────────────────────────────────────

  useEffect(() => {
    appLog.info('App mounted', {
      screen: activeScreen,
      isPreviewMode,
      userAgent: navigator.userAgent,
      windowSize: `${window.innerWidth}×${window.innerHeight}`,
    })
    document.title = 'Earth Contours'
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply reduce-motion class to body when setting is on
  // (enables the CSS reduce-motion override in global.css)
  useEffect(() => {
    if (reduceMotion) {
      document.body.classList.add('reduce-motion')
      log.info('Reduce motion mode enabled')
    } else {
      document.body.classList.remove('reduce-motion')
    }
  }, [reduceMotion])

  // ── Render ──────────────────────────────────────────────────────────────────

  log.debug('App render', {
    activeScreen,
    isPreviewMode,
    splashComplete,
    transitionState,
  })

  return (
    <div className={styles.app}>
      {/* Splash Screen — always rendered until splashComplete */}
      {!splashComplete && <SplashScreen />}

      {/* Main content — shown once splash is done */}
      {splashComplete && (
        <>
          {/* Preview mode: desktop command center showing all screens */}
          {isPreviewMode ? (
            <ErrorBoundary screenName="Preview">
              <PreviewLayout />
            </ErrorBoundary>
          ) : (
            /* Single-screen mode: one active screen with transitions */
            <>
              {/* Screen container — offset by nav height */}
              <div className={`${styles.screenContainer}`}>
                {/* Transition wrapper applies zoom-in/zoom-out animations */}
                <div className={`${styles.screenWrapper} ${styles[transitionState]}`}>
                  <ErrorBoundary
                    screenName={activeScreen.charAt(0).toUpperCase() + activeScreen.slice(1)}
                    key={activeScreen}  // Force ErrorBoundary reset on screen change
                  >
                    {SCREENS[activeScreen]}
                  </ErrorBoundary>
                </div>
              </div>

              {/* Brief black flash during screen transition */}
              <div
                className={`${styles.transitionOverlay} ${transitionState === 'black' ? styles.visible : ''}`}
                aria-hidden="true"
              />

              {/* Navigation bar — always visible in single-screen mode */}
              <Nav />
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── App Component (Router shell) ────────────────────────────────────────────

const App: React.FC = () => {
  return (
    <Routes>
      {/* B2/Dev pages — fullscreen, no nav, no splash */}
      <Route path="/b2-wrap" element={<B2WrapScreen />} />
      <Route path="/b2-wrap-v2" element={<B2WrapV2Screen />} />
      <Route path="/b2-map" element={<B2MapScreen />} />
      <Route path="/scan2" element={<Scan2Screen />} />

      {/* Root — existing Zustand-based app (splash, nav, transitions) */}
      <Route path="/*" element={<MainApp />} />
    </Routes>
  )
}

export default App
