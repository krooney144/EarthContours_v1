/**
 * EarthContours — Desktop Preview Layout ("Command Center")
 *
 * On desktop (window >= 900px), this shows all 3 terrain screens side by side
 * at startup. Click any card to enter that screen full-screen.
 *
 * CRITICAL: This is shown ONCE on initial load on wide screens.
 * After the user clicks into a screen, it never appears again (even on resize).
 * See uiStore.ts for the hasEnteredScreen flag that enforces this.
 *
 * This matches the briefing requirement: "Once in a screen, resizing the window
 * must NEVER send the user back to the preview screen"
 */

import React, { useCallback } from 'react'
import { useUIStore } from '../../store'
import type { ScreenId } from '../../core/types'
import { createLogger } from '../../core/logger'
import styles from './PreviewLayout.module.css'

const log = createLogger('COMPONENT:PREVIEW')

// ─── Card Definitions ─────────────────────────────────────────────────────────

const SCREEN_CARDS: Array<{
  id: ScreenId
  title: string
  description: string
  previewClass: string
  icon: string
}> = [
  {
    id: 'scan',
    title: 'SCAN',
    description: 'AR first-person terrain view. Point and see peak names, elevations, and contour lines.',
    previewClass: 'scanPreview',
    icon: '◉',
  },
  {
    id: 'explore',
    title: 'EXPLORE',
    description: '3D contour-line orbit view. Drag to orbit and explore the terrain in three dimensions.',
    previewClass: 'explorePreview',
    icon: '⬡',
  },
  {
    id: 'map',
    title: 'MAP',
    description: 'Real topographic map. Pan, zoom, and click anywhere to explore that terrain.',
    previewClass: 'mapPreview',
    icon: '⊕',
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

const PreviewLayout: React.FC = () => {
  const enterFromPreview = useUIStore((state) => state.enterFromPreview)
  const navigateTo = useUIStore((state) => state.navigateTo)
  const handleCardClick = useCallback(
    (screenId: ScreenId) => {
      log.info('Preview card clicked — entering screen', { screenId })
      enterFromPreview(screenId)
    },
    [enterFromPreview],
  )

  const handleSettingsClick = useCallback(() => {
    log.info('Preview settings button clicked')
    enterFromPreview('settings')
  }, [enterFromPreview])

  log.debug('PreviewLayout render')

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.logo}>
          <img src="/Favicon3.svg" alt="" className={styles.logoMark} width="32" height="32" aria-hidden="true" />
          <span className={styles.appName}>Earth Contours</span>
        </div>
        <div className={styles.subtitle}>Choose your view</div>
      </div>

      {/* Screen cards */}
      <div className={styles.cards} role="list">
        {SCREEN_CARDS.map((card) => (
          <button
            key={card.id}
            className={styles.card}
            onClick={() => handleCardClick(card.id)}
            role="listitem"
            aria-label={`Enter ${card.title} view — ${card.description}`}
          >
            {/* Preview area */}
            <div className={`${styles.cardPreview} ${styles[card.previewClass as keyof typeof styles]}`}>
              {/* SCAN: Mountain silhouette */}
              {card.id === 'scan' && <ScanPreviewContent />}
              {/* EXPLORE: Contour lines */}
              {card.id === 'explore' && <ExplorePreviewContent />}
              {/* MAP: Map icon */}
              {card.id === 'map' && (
                <div className={styles.previewIcon} aria-hidden="true">{card.icon}</div>
              )}

              <span className={styles.enterHint} aria-hidden="true">ENTER →</span>
            </div>

            {/* Card info */}
            <div className={styles.cardInfo}>
              <div className={styles.cardTitle}>{card.title}</div>
              <div className={styles.cardDescription}>{card.description}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Settings button */}
      <button
        className={styles.settingsBtn}
        onClick={handleSettingsClick}
        aria-label="Open settings"
      >
        ⊞ SETTINGS
      </button>
    </div>
  )
}

// ─── Sub-Components for Preview Cards ────────────────────────────────────────

/** SCAN screen preview — simple mountain silhouette + compass strip */
const ScanPreviewContent: React.FC = () => (
  <>
    <svg
      className={styles.mountainSilhouette}
      viewBox="0 0 300 180"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      {/* Background mountain */}
      <polygon
        points="50,180 150,40 250,180"
        fill="rgba(33, 92, 121, 0.6)"
      />
      {/* Foreground mountain */}
      <polygon
        points="-20,180 90,70 220,180"
        fill="rgba(18, 75, 107, 0.8)"
      />
      {/* Snow cap */}
      <polygon
        points="138,55 150,40 162,55"
        fill="rgba(167, 221, 229, 0.6)"
      />
      {/* Contour line overlay */}
      <line x1="60" y1="120" x2="240" y2="120" stroke="rgba(132,209,219,0.2)" strokeWidth="1"/>
      <line x1="70" y1="100" x2="230" y2="100" stroke="rgba(132,209,219,0.15)" strokeWidth="1"/>
      <line x1="90" y1="80"  x2="210" y2="80"  stroke="rgba(132,209,219,0.1)" strokeWidth="1"/>
    </svg>
    <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', fontSize: 11, fontFamily: 'var(--font-display)', letterSpacing: '0.15em', color: 'var(--ec-glow)', opacity: 0.7 }}>
      N · NNE · NE · ENE · E
    </div>
  </>
)

/** EXPLORE screen preview — glowing contour lines */
const ExplorePreviewContent: React.FC = () => {
  const contourWidths = [40, 60, 80, 95, 80, 60, 40, 25]
  return (
    <div className={styles.contourLines} aria-hidden="true">
      {contourWidths.map((w, i) => (
        <div
          key={i}
          className={styles.contourLine}
          style={{
            width: `${w}%`,
            marginLeft: 'auto',
            marginRight: 'auto',
            opacity: 0.3 + (i / contourWidths.length) * 0.7,
          }}
        />
      ))}
    </div>
  )
}

export default PreviewLayout
