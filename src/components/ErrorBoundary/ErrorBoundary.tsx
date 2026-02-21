/**
 * EarthContours — React Error Boundary
 *
 * React Error Boundaries are class components (can't be functional) that
 * catch JavaScript errors in their child component tree.
 *
 * Without this: one screen crash = entire app white-screen.
 * With this: one screen crash = just that screen shows an error, others work.
 *
 * Each screen is wrapped in its own ErrorBoundary so crashes are isolated.
 *
 * Key method: componentDidCatch() receives the error and error info.
 * getDerivedStateFromError() updates state to show fallback UI.
 */

import React, { Component, ErrorInfo } from 'react'
import { createLogger } from '../../core/logger'
import styles from './ErrorBoundary.module.css'

const log = createLogger('COMPONENT:ERROR_BOUNDARY')

// ─── Props & State ────────────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode
  /** Which screen/area this boundary wraps — for better error messages */
  screenName?: string
  /** Custom fallback UI — if not provided, uses the default error display */
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

// ─── Component ────────────────────────────────────────────────────────────────

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  /**
   * This static method is called when a child throws during render.
   * It must return the new state — React will re-render with this state.
   * Note: this runs BEFORE componentDidCatch, during the render phase.
   */
  static getDerivedStateFromError(error: Error): Partial<State> {
    log.error('Error boundary caught a render error', error)
    return { hasError: true, error }
  }

  /**
   * Called after the error is caught and committed to the DOM.
   * Good place for logging — errorInfo.componentStack shows the React tree.
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { screenName } = this.props

    log.error(`Error in ${screenName ?? 'unknown screen'}`, {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      componentStack: errorInfo.componentStack,
    })

    this.setState({ errorInfo })
  }

  private handleReset = () => {
    log.info('Error boundary reset by user', { screenName: this.props.screenName })
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    const { hasError, error, errorInfo } = this.state
    const { children, fallback, screenName } = this.props

    if (!hasError) {
      // No error — render children normally
      return children
    }

    // Custom fallback provided by parent
    if (fallback) return fallback

    // Default error display
    return (
      <div className={styles.container} role="alert" aria-live="assertive">
        <div className={styles.icon} aria-hidden="true">⚠</div>

        <h2 className={styles.title}>
          {screenName ? `${screenName} Error` : 'Something went wrong'}
        </h2>

        <p className={styles.message}>
          This screen encountered an error. The rest of the app is still working.
          You can try resetting this view or switching to another screen.
        </p>

        {/* Show error details in development */}
        {import.meta.env.DEV && error && (
          <pre className={styles.details}>
            {error.name}: {error.message}
            {errorInfo?.componentStack}
          </pre>
        )}

        <button className={styles.button} onClick={this.handleReset}>
          RESET VIEW
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
