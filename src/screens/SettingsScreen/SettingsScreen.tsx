/**
 * EarthContours — SETTINGS Screen
 *
 * 7 sections of app configuration:
 * 1. Units & Measurements
 * 2. Map & Terrain Display
 * 3. Appearance
 * 4. Location & Sensors
 * 5. Performance & Battery
 * 6. Data & Downloads
 * 7. Feedback & Support
 *
 * All settings persist to localStorage via the settingsStore.
 * Changes take effect immediately (reactive via Zustand).
 */

import React, { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore, useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
import { submitFeedback } from '../../data/feedbackService'
import type { VerticalExaggeration, UnitSystem, CoordFormat, TargetFPS, BatteryMode, GPSAccuracy } from '../../core/types'
import styles from './SettingsScreen.module.css'

const log = createLogger('SCREEN:SETTINGS')

// ─── Helper sub-components ─────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean
  onChange: () => void
  id: string
  label: string
}

const Toggle: React.FC<ToggleProps> = ({ checked, onChange, id, label }) => (
  <label className={styles.toggle} htmlFor={id} aria-label={label}>
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={onChange}
    />
    <div className={styles.toggleTrack} />
    <div className={styles.toggleThumb} />
  </label>
)

interface SegmentedProps<T extends string | number> {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}

function Segmented<T extends string | number>({
  options, value, onChange, ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className={styles.segmented} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          className={`${styles.segmentBtn} ${value === opt.value ? styles.active : ''}`}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

interface RowProps {
  label: string
  description?: string
  children: React.ReactNode
}

const Row: React.FC<RowProps> = ({ label, description, children }) => (
  <div className={styles.row}>
    <div className={styles.rowLeft}>
      <div className={styles.rowLabel}>{label}</div>
      {description && <div className={styles.rowDescription}>{description}</div>}
    </div>
    {children}
  </div>
)

interface SectionProps {
  icon: string
  title: string
  children: React.ReactNode
}

const Section: React.FC<SectionProps> = ({ icon, title, children }) => (
  <div className={styles.section}>
    <div className={styles.sectionHeader}>
      <span className={styles.sectionIcon} aria-hidden="true">{icon}</span>
      <span className={styles.sectionTitle}>{title}</span>
    </div>
    {children}
  </div>
)

// ─── Main Component ────────────────────────────────────────────────────────────

const SettingsScreen: React.FC = () => {
  const settings = useSettingsStore()
  const { gpsPermission, requestGPS } = useLocationStore()

  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [feedbackIssueUrl, setFeedbackIssueUrl] = useState<string | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [showLocationHelp, setShowLocationHelp] = useState(false)
  const navigate = useNavigate()

  log.debug('SettingsScreen render', {
    units: settings.units,
    verticalExaggeration: settings.verticalExaggeration,
  })

  /**
   * Submit feedback as a GitHub Issue in krooney144/EarthContours_v1.
   * Requires VITE_GITHUB_TOKEN in .env.local (see feedbackService.ts for setup).
   * Shows success with a link to the created issue, or an error message.
   * TODO: Add category selector (bug / feature / general feedback).
   * TODO: Allow attaching screenshots.
   */
  const handleFeedbackSubmit = useCallback(async () => {
    if (!feedbackText.trim()) return

    setFeedbackStatus('sending')
    setFeedbackError(null)
    setFeedbackIssueUrl(null)

    log.info('Submitting feedback to GitHub', { length: feedbackText.length })

    const result = await submitFeedback(feedbackText)

    if (result.success) {
      setFeedbackStatus('sent')
      setFeedbackIssueUrl(result.issueUrl ?? null)
      setFeedbackText('')
      // Reset status after 5s so user can submit more feedback
      setTimeout(() => {
        setFeedbackStatus('idle')
        setFeedbackIssueUrl(null)
      }, 5000)
    } else {
      setFeedbackStatus('error')
      setFeedbackError(result.error ?? 'Unknown error')
      log.error('Feedback submission failed', { error: result.error })
    }
  }, [feedbackText])

  const handleExportLogs = useCallback(() => {
    log.info('Export logs triggered')
    const logData = `EarthContours Log Export\n${new Date().toISOString()}\n\nLog export not yet implemented in MVP.\nCheck browser console for detailed logs.`
    const blob = new Blob([logData], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `earthcontours-logs-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleResetSettings = useCallback(() => {
    if (!resetConfirm) {
      setResetConfirm(true)
      setTimeout(() => setResetConfirm(false), 3000)
      return
    }
    log.warn('Settings reset confirmed by user')
    settings.resetToDefaults()
    setResetConfirm(false)
  }, [resetConfirm, settings])

  const handleRequestGPS = useCallback(async () => {
    log.info('GPS permission request triggered from settings')
    try {
      await requestGPS()
    } catch (err) {
      log.error('GPS request failed from settings', err)
    }
  }, [requestGPS])

  // 1× = physically correct metres; higher = artistic exaggeration of real elevation
  const EXAGGERATION_OPTIONS: VerticalExaggeration[] = [1, 2, 4, 10, 20]

  return (
    <div className={styles.screen}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>SETTINGS</div>
        <div className={styles.headerSubtitle}>App preferences and configuration</div>
      </div>

      {/* Scrollable content */}
      <div className={styles.scrollArea} role="main">

        {/* ── Section 1: Units & Measurements ── */}
        <Section icon="⊡" title="Units & Measurements">
          <Row label="Unit System" description="Feet and miles, or meters and km">
            <Segmented<UnitSystem>
              options={[
                { value: 'imperial', label: 'Imperial' },
                { value: 'metric',   label: 'Metric' },
              ]}
              value={settings.units}
              onChange={(v) => { log.info('Units changed', { to: v }); settings.setUnits(v) }}
              ariaLabel="Unit system"
            />
          </Row>
          <Row label="Coordinate Format" description="How GPS coordinates are displayed">
            <Segmented<CoordFormat>
              options={[
                { value: 'decimal', label: 'Dec' },
                { value: 'dms',     label: 'DMS' },
                { value: 'utm',     label: 'UTM' },
              ]}
              value={settings.coordFormat}
              onChange={(v) => { log.info('Coord format changed', { to: v }); settings.setCoordFormat(v) }}
              ariaLabel="Coordinate format"
            />
          </Row>
        </Section>

        {/* ── Section 2: Map & Terrain ── */}
        <Section icon="◭" title="Map & Terrain">
          <Row label="Peak Labels" description="Show mountain name labels on terrain">
            <Toggle
              id="toggle-peaks"
              label="Toggle peak labels"
              checked={settings.showPeakLabels}
              onChange={settings.togglePeakLabels}
            />
          </Row>
          <Row label="Rivers" description="Show rivers and streams on map">
            <Toggle
              id="toggle-rivers"
              label="Toggle rivers"
              checked={settings.showRivers}
              onChange={settings.toggleRivers}
            />
          </Row>
          <Row label="Lakes" description="Show lakes and reservoirs on map">
            <Toggle
              id="toggle-lakes"
              label="Toggle lakes"
              checked={settings.showLakes}
              onChange={settings.toggleLakes}
            />
          </Row>
          <Row label="Glaciers" description="Show glaciated areas on map">
            <Toggle
              id="toggle-glaciers"
              label="Toggle glaciers"
              checked={settings.showGlaciers}
              onChange={settings.toggleGlaciers}
            />
          </Row>
          <Row label="Coastlines" description="Show coastline outlines on map">
            <Toggle
              id="toggle-coastlines"
              label="Toggle coastlines"
              checked={settings.showCoastlines}
              onChange={settings.toggleCoastlines}
            />
          </Row>
          <Row label="Town Labels" description="Show cities and towns (off by default)">
            <Toggle
              id="toggle-towns"
              label="Toggle town labels"
              checked={settings.showTownLabels}
              onChange={settings.toggleTownLabels}
            />
          </Row>
          <Row label="Contour Lines" description="Show elevation contour lines on terrain">
            <Toggle
              id="toggle-contours"
              label="Toggle contour lines"
              checked={settings.showContourLines}
              onChange={settings.toggleContourLines}
            />
          </Row>
          <Row label="Solid Terrain" description="Show solid 3D mesh in EXPLORE (off = contour lines only)">
            <Toggle
              id="toggle-solid-terrain"
              label="Toggle solid terrain"
              checked={settings.solidTerrain}
              onChange={settings.toggleSolidTerrain}
            />
          </Row>
          <Row label="Band Lines" description="Show depth band ridgeline strokes in SCAN view">
            <Toggle
              id="toggle-bandlines"
              label="Toggle band lines"
              checked={settings.showBandLines}
              onChange={settings.toggleBandLines}
            />
          </Row>
          <Row label="Terrain Fill" description="Show solid fill below ridgelines in SCAN view">
            <Toggle
              id="toggle-fill"
              label="Toggle terrain fill"
              checked={settings.showFill}
              onChange={settings.toggleFill}
            />
          </Row>
          <Row label="Contour Animation" description="Slow pulsing glow on contour lines">
            <Toggle
              id="toggle-contour-anim"
              label="Toggle contour animation"
              checked={settings.contourAnimation}
              onChange={settings.toggleContourAnimation}
            />
          </Row>
          <Row label="Debug Panel" description="Show diagnostics overlay on SCAN screen">
            <Toggle
              id="toggle-debug-panel"
              label="Toggle debug panel"
              checked={settings.showDebugPanel}
              onChange={settings.toggleDebugPanel}
            />
          </Row>
          <Row
            label="Vertical Exaggeration"
            description="Multiply terrain heights for dramatic effect"
          >
            <div className={styles.exagOptions}>
              {EXAGGERATION_OPTIONS.map((v) => (
                <button
                  key={v}
                  className={`${styles.exagBtn} ${settings.verticalExaggeration === v ? styles.active : ''}`}
                  onClick={() => {
                    log.info('Vertical exaggeration changed', { to: v })
                    settings.setVerticalExaggeration(v)
                  }}
                  aria-pressed={settings.verticalExaggeration === v}
                  aria-label={`${v}× vertical exaggeration`}
                >
                  {v}×
                </button>
              ))}
            </div>
          </Row>
        </Section>

        {/* ── Section 3: Appearance ── */}
        <Section icon="◈" title="Appearance">
          <Row label="Label Size" description="Size of peak and terrain labels">
            <Segmented<'small' | 'medium' | 'large'>
              options={[
                { value: 'small',  label: 'S' },
                { value: 'medium', label: 'M' },
                { value: 'large',  label: 'L' },
              ]}
              value={settings.labelSize}
              onChange={(v) => {
                log.info('Label size changed', { to: v })
                settings.setLabelSize(v)
              }}
              ariaLabel="Label size"
            />
          </Row>
          <Row label="Reduce Motion" description="Disable animations (accessibility)">
            <Toggle
              id="toggle-motion"
              label="Toggle reduce motion"
              checked={settings.reduceMotion}
              onChange={settings.toggleReduceMotion}
            />
          </Row>
        </Section>

        {/* ── Section 4: Location & Sensors ── */}
        <Section icon="◎" title="Location & Sensors">
          <Row
            label="GPS Permission"
            description={
              gpsPermission === 'denied'
                ? 'Location was denied — tap HOW TO ENABLE for instructions'
                : 'Required for real-time position tracking'
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span className={`${styles.statusBadge} ${
                gpsPermission === 'granted'     ? styles.statusGranted :
                gpsPermission === 'denied'      ? styles.statusDenied  :
                                                  styles.statusUnknown
              }`}>
                {gpsPermission === 'granted'     ? '● GRANTED' :
                 gpsPermission === 'denied'      ? '✕ DENIED'  :
                 gpsPermission === 'unavailable' ? '— N/A'     :
                                                   '? UNKNOWN' }
              </span>
              {gpsPermission === 'denied' ? (
                <button
                  className={styles.actionBtn}
                  onClick={() => setShowLocationHelp((v) => !v)}
                >
                  {showLocationHelp ? 'HIDE' : 'HOW TO ENABLE'}
                </button>
              ) : gpsPermission !== 'granted' ? (
                <button className={styles.actionBtn} onClick={handleRequestGPS}>
                  REQUEST
                </button>
              ) : null}
            </div>
          </Row>
          {showLocationHelp && gpsPermission === 'denied' && (
            <div className={styles.locationHelp} role="note">
              <div className={styles.locationHelpTitle}>Re-enable Location Access</div>
              <div className={styles.locationHelpBody}>
                <p><strong>iPhone (Safari):</strong></p>
                <p>Settings &gt; Privacy &amp; Security &gt; Location Services &gt; Safari Websites &gt; While Using the App</p>
                <p><strong>iPhone (Chrome):</strong></p>
                <p>Settings &gt; Chrome &gt; Location &gt; While Using the App</p>
                <p><strong>Android (Chrome):</strong></p>
                <p>Tap the lock icon in the address bar &gt; Permissions &gt; Location &gt; Allow</p>
                <p><strong>Desktop Chrome:</strong></p>
                <p>Click the lock icon left of the URL &gt; Site settings &gt; Location &gt; Allow</p>
                <p><strong>Desktop Safari:</strong></p>
                <p>Safari &gt; Settings &gt; Websites &gt; Location &gt; Allow</p>
                <p><strong>Desktop Firefox:</strong></p>
                <p>Click the lock icon left of the URL &gt; Clear permission &gt; Reload page</p>
              </div>
              <button
                className={styles.actionBtn}
                onClick={() => {
                  log.info('User attempting GPS re-request after reading help')
                  handleRequestGPS()
                }}
                style={{ marginTop: 'var(--space-3)' }}
              >
                TRY AGAIN
              </button>
            </div>
          )}
          <Row label="GPS Accuracy" description="Higher accuracy uses more battery">
            <Segmented<GPSAccuracy>
              options={[
                { value: 'high',   label: 'High' },
                { value: 'medium', label: 'Med' },
                { value: 'low',    label: 'Low' },
              ]}
              value={settings.locationAccuracy}
              onChange={(v) => {
                log.info('GPS accuracy changed', { to: v })
                settings.setLocationAccuracy(v)
              }}
              ariaLabel="GPS accuracy"
            />
          </Row>
          <Row label="Auto-Detect Region" description="Switch terrain data when you travel to a new region">
            <Toggle
              id="toggle-autoregion"
              label="Toggle auto-detect region"
              checked={settings.autoDetectRegion}
              onChange={settings.toggleAutoDetectRegion}
            />
          </Row>
        </Section>

        {/* ── Section 5: Performance & Battery ── */}
        <Section icon="⬡" title="Performance & Battery">
          <Row label="Battery Saver" description="Reduces 3D rendering quality to save power">
            <Segmented<BatteryMode>
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'on',   label: 'On' },
                { value: 'off',  label: 'Off' },
              ]}
              value={settings.batteryMode}
              onChange={(v) => {
                log.info('Battery mode changed', { to: v })
                settings.setBatteryMode(v)
              }}
              ariaLabel="Battery saver mode"
            />
          </Row>
          <Row label="Frame Rate" description="Target render frame rate for 3D screens">
            <Segmented<TargetFPS>
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 60,     label: '60fps' },
                { value: 30,     label: '30fps' },
              ]}
              value={settings.targetFPS}
              onChange={(v) => {
                log.info('Target FPS changed', { to: v })
                settings.setTargetFPS(v)
              }}
              ariaLabel="Target frame rate"
            />
          </Row>
        </Section>

        {/* ── Section 6: Data & Downloads ── */}
        <Section icon="⊕" title="Data & Downloads">
          <Row label="WiFi Only Downloads" description="Only download terrain data on WiFi (recommended)">
            <Toggle
              id="toggle-wifi"
              label="Toggle WiFi only downloads"
              checked={settings.downloadOnWifiOnly}
              onChange={settings.toggleDownloadOnWifiOnly}
            />
          </Row>
          <Row label="Data Resolution" description="Higher resolution = more detail, larger download">
            <Segmented<'10m' | '30m' | '90m'>
              options={[
                { value: '10m', label: '10m' },
                { value: '30m', label: '30m' },
                { value: '90m', label: '90m' },
              ]}
              value={settings.dataResolution}
              onChange={(v) => {
                log.info('Data resolution changed', { to: v })
                settings.setDataResolution(v)
              }}
              ariaLabel="Data resolution"
            />
          </Row>
          <Row
            label="Downloaded Regions"
            description="Terrain data from AWS Terrarium DEM tiles, cached locally"
          >
            <button className={styles.actionBtn} onClick={() => log.info('Download region tapped')}>
              + ADD
            </button>
          </Row>
          <Row label="Colorado Rockies" description="~220 × 250 km · AWS Terrarium tiles">
            <span className={`${styles.statusBadge} ${styles.statusGranted}`}>✓ LOADED</span>
          </Row>
          <Row label="Alaska Range — Denali" description="~255 × 220 km · AWS Terrarium tiles">
            <span className={`${styles.statusBadge} ${styles.statusGranted}`}>✓ LOADED</span>
          </Row>
        </Section>

        {/* ── Section 7: Feedback & Support ── */}
        {/* Feedback is submitted as a GitHub Issue via /api/feedback serverless function.
            TODO: Add category picker (bug, feature request, general).
            TODO: Support screenshot attachment via paste or file picker. */}
        <Section icon="✉" title="Feedback & Support">
          <div className={styles.feedbackArea}>
            <textarea
              className={styles.textarea}
              placeholder="Describe a bug, request a feature, or share feedback..."
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              aria-label="Feedback text"
              rows={4}
              disabled={feedbackStatus === 'sending'}
            />
            <div className={styles.feedbackActions}>
              <button
                className={styles.actionBtn}
                onClick={handleFeedbackSubmit}
                disabled={!feedbackText.trim() || feedbackStatus === 'sending'}
                aria-label="Submit feedback as GitHub issue"
              >
                {feedbackStatus === 'sending' ? 'SENDING...' :
                 feedbackStatus === 'sent'    ? '✓ SENT' :
                 feedbackStatus === 'error'   ? 'RETRY' :
                                                'SUBMIT'}
              </button>
              <button
                className={styles.actionBtn}
                onClick={handleExportLogs}
                aria-label="Export debug logs"
              >
                EXPORT LOGS
              </button>
            </div>

            {/* Success message with link to the created GitHub issue */}
            {feedbackStatus === 'sent' && feedbackIssueUrl && (
              <div className={styles.feedbackSuccess} role="status">
                Feedback submitted!{' '}
                <a
                  href={feedbackIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.feedbackLink}
                >
                  View issue on GitHub
                </a>
              </div>
            )}

            {/* Error message */}
            {feedbackStatus === 'error' && feedbackError && (
              <div className={styles.feedbackErrorMsg} role="alert">
                {feedbackError}
              </div>
            )}
          </div>
          <Row label="Reset All Settings" description="Restore all settings to their default values">
            <button
              className={`${styles.actionBtn} ${styles.danger}`}
              onClick={handleResetSettings}
              aria-label={resetConfirm ? 'Confirm settings reset' : 'Reset all settings'}
            >
              {resetConfirm ? 'CONFIRM?' : 'RESET'}
            </button>
          </Row>
        </Section>

        {/* ── Section 8: Dev Pages ── */}
        <Section icon="⚙" title="Dev Pages">
          <Row label="B2 Wrap" description="360° cylindrical projection — Scan V1">
            <button className={styles.actionBtn} onClick={() => navigate('/b2-wrap')}>
              OPEN
            </button>
          </Row>
          <Row label="B2 Wrap V2" description="360° cylindrical projection — Scan V2">
            <button className={styles.actionBtn} onClick={() => navigate('/b2-wrap-v2')}>
              OPEN
            </button>
          </Row>
          <Row label="B2 Map" description="Top-down table projection — 1920×1920">
            <button className={styles.actionBtn} onClick={() => navigate('/b2-map')}>
              OPEN
            </button>
          </Row>
          <Row label="Scan 2" description="First-person terrain test environment">
            <button className={styles.actionBtn} onClick={() => navigate('/scan2')}>
              OPEN
            </button>
          </Row>
        </Section>

        {/* Version info */}
        <div className={styles.versionInfo}>
          <div className={styles.logoMark}>◈</div>
          <div className={styles.versionText}>Earth Contours v1.0 MVP</div>
          <div className={styles.versionText}>Built with React + Vite + Zustand</div>
          <div className={styles.versionText}>Map tiles © OpenTopoMap contributors</div>
        </div>

      </div>
    </div>
  )
}

export default SettingsScreen
