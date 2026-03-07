/**
 * EarthContours — Feedback Service
 *
 * Submits user feedback via the /api/feedback serverless function,
 * which creates GitHub Issues in the project repo. The GitHub token
 * lives server-side only — never in the client bundle.
 *
 * Setup:
 *   Production (Vercel):
 *     Add GITHUB_TOKEN in Vercel dashboard → Settings → Environment Variables
 *
 *   Local development:
 *     Add to .env.local:  GITHUB_TOKEN=ghp_your_token_here
 *     The Vite dev server proxies /api/* to the Vercel dev server,
 *     or you can run `vercel dev` locally.
 *
 * TODO: Add rate limiting to prevent abuse.
 * TODO: Support image attachments (screenshots).
 */

import { createLogger } from '../core/logger'

const log = createLogger('FEEDBACK')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FeedbackResult {
  success: boolean
  /** URL of the created issue (only if success) */
  issueUrl?: string
  /** Error message (only if !success) */
  error?: string
}

// ─── Device Info Collector ──────────────────────────────────────────────────

/**
 * Collects basic device/browser info to attach to the issue.
 * Helps with debugging — no PII is collected.
 */
function getDeviceInfo(): string {
  const ua = navigator.userAgent
  const screen = `${window.screen.width}×${window.screen.height}`
  const viewport = `${window.innerWidth}×${window.innerHeight}`
  const dpr = window.devicePixelRatio?.toFixed(1) ?? '?'
  const touch = 'ontouchstart' in window ? 'yes' : 'no'

  return [
    `**User Agent:** \`${ua}\``,
    `**Screen:** ${screen} · **Viewport:** ${viewport} · **DPR:** ${dpr}`,
    `**Touch:** ${touch}`,
  ].join('\n')
}

// ─── Submit Feedback ────────────────────────────────────────────────────────

/**
 * Submit user feedback via the server-side API route.
 *
 * The API route (/api/feedback) creates a GitHub Issue with:
 *   - Title: first 80 chars of the feedback text
 *   - Body: full feedback + device info
 *   - Label: "user-feedback"
 *
 * @param feedbackText - The user's feedback message
 * @returns Result with success status and issue URL or error
 */
export async function submitFeedback(feedbackText: string): Promise<FeedbackResult> {
  log.info('Submitting feedback', { textLength: feedbackText.length })

  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: feedbackText,
        deviceInfo: getDeviceInfo(),
      }),
    })

    const data = await response.json()

    if (!response.ok || !data.success) {
      const error = data.error ?? `Server error (${response.status})`
      log.error('Feedback submission failed', { status: response.status, error })
      return { success: false, error }
    }

    log.info('Feedback submitted successfully', { issueUrl: data.issueUrl })
    return { success: true, issueUrl: data.issueUrl }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Failed to submit feedback', { error: message })
    return { success: false, error: `Network error: ${message}` }
  }
}
