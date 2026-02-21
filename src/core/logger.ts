/**
 * EarthContours — Custom Logger
 *
 * EXTREME LOGGING is a core requirement of this app.
 * Every store action, screen render, user gesture, and error gets logged.
 *
 * Why a custom logger instead of just console.log?
 * 1. Namespaced: each log shows WHERE it came from (STORE:TERRAIN, SCREEN:SCAN, etc.)
 * 2. Color-coded: debug=grey, info=blue, warn=yellow, error=red — easy to scan
 * 3. Filterable: in production we can turn off debug logs
 * 4. Timestamped: relative timestamps show timing relationships
 *
 * Usage:
 *   const log = createLogger('SCREEN:SCAN')
 *   log.info('AR drag start', { heading: 42.1 })
 *   log.warn('GPS unavailable, using simulated position')
 *   log.error('Terrain load failed', error)
 */

// ─── Log Levels ───────────────────────────────────────────────────────────────

/** Numeric severity — higher = more severe */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const

export type LogLevel = keyof typeof LOG_LEVELS

// ─── Configuration ────────────────────────────────────────────────────────────

/** Minimum level to actually output. Change to 'warn' to silence debug/info in production. */
const MIN_LEVEL: LogLevel = 'debug'

/** Whether to include timestamps in log output */
const SHOW_TIMESTAMPS = true

/** App start time for relative timestamps */
const APP_START = performance.now()

// ─── Color Styles ─────────────────────────────────────────────────────────────

/**
 * Browser console supports CSS via the %c format specifier.
 * These styles color-code each log level for easy scanning.
 */
const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: 'color: #888; font-weight: normal;',
  info:  'color: #4B8EA3; font-weight: bold;',
  warn:  'color: #E6A817; font-weight: bold;',
  error: 'color: #E64B4B; font-weight: bold; background: #2a0000;',
}

const NAMESPACE_STYLE = 'color: #84D1DB; font-weight: bold;'
const TIMESTAMP_STYLE = 'color: #555; font-size: 0.9em;'
const RESET_STYLE = 'color: inherit; font-weight: normal;'

// ─── Logger Factory ───────────────────────────────────────────────────────────

/** A logger bound to a specific namespace */
export interface Logger {
  debug: (message: string, data?: unknown) => void
  info:  (message: string, data?: unknown) => void
  warn:  (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
  /** Log a group of related messages — useful for complex state changes */
  group: (label: string, fn: () => void) => void
  /** Log entry/exit of a function with timing */
  time:  (label: string) => () => void
}

/**
 * Creates a namespace-scoped logger.
 *
 * @param namespace - Identifies where the log comes from. Convention:
 *   'STORE:TERRAIN', 'SCREEN:SCAN', 'COMPONENT:NAV', 'RENDERER:THREE'
 */
export function createLogger(namespace: string): Logger {
  /**
   * Core log function that all level-specific functions delegate to.
   * Uses console[level] to preserve the browser's stack trace feature.
   */
  function log(level: LogLevel, message: string, data?: unknown): void {
    // Skip if this level is below our minimum threshold
    if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return

    const elapsed = ((performance.now() - APP_START) / 1000).toFixed(2)

    if (SHOW_TIMESTAMPS) {
      // Format: [+12.34s] [NAMESPACE] MESSAGE {data}
      // %c applies the next string as CSS to the following text
      const parts: string[] = [
        `%c[+${elapsed}s]%c [%c${namespace}%c] %c${message}%c`,
        TIMESTAMP_STYLE,
        RESET_STYLE,
        NAMESPACE_STYLE,
        RESET_STYLE,
        LEVEL_STYLES[level],
        RESET_STYLE,
      ]
      if (data !== undefined) {
        console[level](...parts, data)
      } else {
        console[level](...parts)
      }
    } else {
      if (data !== undefined) {
        console[level](`[${namespace}] ${message}`, data)
      } else {
        console[level](`[${namespace}] ${message}`)
      }
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info:  (msg, data) => log('info', msg, data),
    warn:  (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),

    group(label: string, fn: () => void): void {
      console.groupCollapsed(`[${namespace}] ${label}`)
      try { fn() } finally { console.groupEnd() }
    },

    time(label: string): () => void {
      const start = performance.now()
      log('debug', `⏱ START: ${label}`)
      return () => {
        const duration = (performance.now() - start).toFixed(1)
        log('debug', `⏱ END: ${label} — ${duration}ms`)
      }
    },
  }
}

// ─── Global App Logger ────────────────────────────────────────────────────────

/** Root-level logger for App.tsx and main.tsx */
export const appLog = createLogger('APP')

/** Log unhandled errors globally */
export function setupGlobalErrorLogging(): void {
  const log = createLogger('GLOBAL:ERROR')

  window.addEventListener('error', (event) => {
    log.error('Unhandled JavaScript error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      col: event.colno,
      error: event.error,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    log.error('Unhandled Promise rejection', {
      reason: event.reason,
    })
  })

  log.info('Global error logging initialized')
}
