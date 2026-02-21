/**
 * EarthContours — Loading Screen
 *
 * Shows while terrain data is loading within a screen.
 * Distinct from SplashScreen (which is only shown at app startup).
 * This is shown when switching regions or when terrain data needs to reload.
 */

import React from 'react'
import { createLogger } from '../../core/logger'
import styles from './LoadingScreen.module.css'

const log = createLogger('COMPONENT:LOADING')

interface Props {
  message?: string
  progress?: number   // 0–100, if undefined shows spinner only
  onRetry?: () => void
  isError?: boolean
}

const LoadingScreen: React.FC<Props> = ({ message, progress, onRetry, isError }) => {
  log.debug('LoadingScreen render', { message, progress, isError })

  return (
    <div className={styles.container} role={isError ? 'alert' : 'status'} aria-live="polite">
      {isError ? (
        <div className={styles.errorIcon}>⚠</div>
      ) : (
        <div className={styles.spinner} aria-hidden="true" />
      )}

      <div className={styles.message}>
        {message ?? (isError ? 'Load failed' : 'Loading...')}
      </div>

      {progress !== undefined && !isError && (
        <div className={styles.progress} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      )}

      {isError && onRetry && (
        <button className={styles.retryButton} onClick={onRetry}>
          RETRY
        </button>
      )}
    </div>
  )
}

export default LoadingScreen
