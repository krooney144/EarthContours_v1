/**
 * EarthContours — Bottom Navigation Bar
 *
 * The 4-tab nav at the bottom: SCAN · EXPLORE · MAP · SETTINGS
 *
 * Uses Josefin Sans (display font) per briefing.
 * The active tab has a glow indicator at the top.
 *
 * Why not use React Router's <Link>?
 * EarthContours uses a custom state-based router (not URL routing) because:
 * 1. The app is designed as a native-feeling app, not a webpage
 * 2. The 3D/AR screens need to persist state between visits
 * 3. We want full control over the zoom transition animation
 */

import React, { useCallback } from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import { createLogger } from '../../core/logger'
import styles from './Nav.module.css'

const log = createLogger('COMPONENT:NAV')

// ─── Tab Definitions ──────────────────────────────────────────────────────────

const TABS: Array<{ id: ScreenId; label: string; icon: string; ariaLabel: string }> = [
  { id: 'scan',     label: 'SCAN',     icon: '◉', ariaLabel: 'Scan — AR terrain view' },
  { id: 'explore',  label: 'EXPLORE',  icon: '⬡', ariaLabel: 'Explore — 3D terrain view' },
  { id: 'map',      label: 'MAP',      icon: '⊕', ariaLabel: 'Map — Topographic map' },
  { id: 'settings', label: 'SETTINGS', icon: '⊞', ariaLabel: 'Settings' },
]

// ─── Component ────────────────────────────────────────────────────────────────

const Nav: React.FC = () => {
  const activeScreen = useUIStore((state) => state.activeScreen)
  const navigateTo = useUIStore((state) => state.navigateTo)
  const isPreviewMode = useUIStore((state) => state.isPreviewMode)

  const handleTabClick = useCallback(
    (screenId: ScreenId) => {
      log.info('Nav tab clicked', {
        from: activeScreen,
        to: screenId,
        isPreviewMode,
      })
      navigateTo(screenId)
    },
    [activeScreen, navigateTo, isPreviewMode],
  )

  return (
    <nav className={styles.nav} role="navigation" aria-label="Main navigation">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`${styles.tab} ${activeScreen === tab.id && !isPreviewMode ? styles.active : ''}`}
          onClick={() => handleTabClick(tab.id)}
          aria-label={tab.ariaLabel}
          aria-current={activeScreen === tab.id ? 'page' : undefined}
          role="tab"
        >
          <span className={styles.icon} aria-hidden="true">{tab.icon}</span>
          <span className={styles.label}>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}

export default Nav
