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
import { useSettingsStore, useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
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
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)

  log.debug('SettingsScreen render', {
    units: settings.units,
    appName: settings.appName,
    verticalExaggeration: settings.verticalExaggeration,
  })

  const handleFeedbackSubmit = useCallback(() => {
    if (!feedbackText.trim()) return
    log.info('Feedback submitted', { length: feedbackText.length })
    // In production: send to feedback API
    console.info('[FEEDBACK]', feedbackText)
    setFeedbackSent(true)
    setFeedbackText('')
    setTimeout(() => setFeedbackSent(false), 3000)
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

  const EXAGGERATION_OPTIONS: VerticalExaggeration[] = [1, 1.5, 2, 3, 4, 5]

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
          <Row label="River Labels" description="Show river and stream names">
            <Toggle
              id="toggle-rivers"
              label="Toggle river labels"
              checked={settings.showRiverLabels}
              onChange={settings.toggleRiverLabels}
            />
          </Row>
          <Row label="Water Body Labels" description="Show lake and reservoir names">
            <Toggle
              id="toggle-water"
              label="Toggle water labels"
              checked={settings.showWaterLabels}
              onChange={settings.toggleWaterLabels}
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
          <Row label="Contour Animation" description="Slow pulsing glow on contour lines">
            <Toggle
              id="toggle-contour-anim"
              label="Toggle contour animation"
              checked={settings.contourAnimation}
              onChange={settings.toggleContourAnimation}
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
          <Row
            label="App Name"
            description="Compare two name options for the app"
          >
            <Segmented<'EarthContours' | 'Earthscape'>
              options={[
                { value: 'EarthContours', label: 'EarthContours' },
                { value: 'Earthscape',    label: 'Earthscape' },
              ]}
              value={settings.appName}
              onChange={(v) => {
                log.info('App name changed', { to: v })
                settings.setAppName(v)
              }}
              ariaLabel="App name preference"
            />
          </Row>
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
          <Row label="GPS Permission" description="Required for real-time position tracking">
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
              {gpsPermission !== 'granted' && (
                <button className={styles.actionBtn} onClick={handleRequestGPS}>
                  REQUEST
                </button>
              )}
            </div>
          </Row>
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
            description="Colorado Rockies and Anchorage, AK are pre-loaded (simulated for MVP)"
          >
            <button className={styles.actionBtn} onClick={() => log.info('Download region tapped')}>
              + ADD
            </button>
          </Row>
          <Row label="Colorado Rockies" description="Pre-loaded · 40km × 40km · Simulated">
            <span className={`${styles.statusBadge} ${styles.statusGranted}`}>✓ LOADED</span>
          </Row>
          <Row label="Anchorage, Alaska" description="Pre-loaded · 40km × 40km · Simulated">
            <span className={`${styles.statusBadge} ${styles.statusGranted}`}>✓ LOADED</span>
          </Row>
        </Section>

        {/* ── Section 7: Feedback & Support ── */}
        <Section icon="✉" title="Feedback & Support">
          <div className={styles.feedbackArea}>
            <textarea
              className={styles.textarea}
              placeholder="Describe a bug, request a feature, or share feedback..."
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              aria-label="Feedback text"
              rows={4}
            />
            <div className={styles.feedbackActions}>
              <button
                className={styles.actionBtn}
                onClick={handleFeedbackSubmit}
                disabled={!feedbackText.trim()}
                aria-label="Submit feedback"
              >
                {feedbackSent ? '✓ SENT' : 'SUBMIT'}
              </button>
              <button
                className={styles.actionBtn}
                onClick={handleExportLogs}
                aria-label="Export debug logs"
              >
                EXPORT LOGS
              </button>
            </div>
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

        {/* Version info */}
        <div className={styles.versionInfo}>
          <div className={styles.logoMark}>◈</div>
          <div className={styles.versionText}>{settings.appName} v1.0 MVP</div>
          <div className={styles.versionText}>Built with React + Vite + Zustand</div>
          <div className={styles.versionText}>Map tiles © OpenTopoMap contributors</div>
        </div>

      </div>
    </div>
  )
}

export default SettingsScreen
