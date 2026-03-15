/**
 * EarthContours — Application Entry Point
 *
 * main.tsx is the first file executed by Vite.
 * It:
 * 1. Sets up global error logging
 * 2. Imports global CSS styles
 * 3. Mounts the React root into the #root div
 *
 * React 18 uses createRoot() instead of the old ReactDOM.render().
 * createRoot() enables Concurrent Mode features like automatic batching
 * and Suspense for data fetching.
 *
 * StrictMode is enabled — it double-invokes effects in development to
 * help catch bugs (effects that don't properly clean up will cause issues).
 * StrictMode doesn't affect production builds.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { setupGlobalErrorLogging, appLog } from './core/logger'
import './styles/global.css'

// Set up global error/rejection handlers BEFORE anything else
setupGlobalErrorLogging()

appLog.info('EarthContours starting...', {
  version: '1.0.0-mvp',
  env: import.meta.env.MODE,
  buildTime: new Date().toISOString(),
  platform: navigator.platform,
  language: navigator.language,
})

// Find the root DOM element
const rootElement = document.getElementById('root')

if (!rootElement) {
  // This should never happen — but if it does, we want a clear error
  const errMsg = 'FATAL: #root element not found in index.html. The app cannot mount.'
  appLog.error(errMsg)
  throw new Error(errMsg)
}

// Create the React root and mount the app
const root = ReactDOM.createRoot(rootElement)

root.render(
  /**
   * StrictMode:
   * - In development: effects run twice to detect side effect bugs
   * - In production: no-op (StrictMode is stripped at build time)
   * - We keep it on because it catches real bugs early
   */
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

appLog.info('React root mounted to #root')
