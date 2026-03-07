/**
 * EarthContours — Feedback Service
 *
 * Creates GitHub Issues in the project repo from the in-app feedback form.
 * Uses the GitHub REST API with a Personal Access Token stored in a Vite
 * environment variable (VITE_GITHUB_TOKEN).
 *
 * Setup:
 *   1. Create a GitHub Personal Access Token with `public_repo` scope
 *      (or `repo` for private repos) at https://github.com/settings/tokens
 *   2. Create a `.env.local` file in the project root:
 *        VITE_GITHUB_TOKEN=ghp_your_token_here
 *   3. Restart the dev server — Vite injects it at build time.
 *
 * Security note:
 *   The token is embedded in the client bundle. This is acceptable for
 *   personal/internal use. For a public deployment, replace this with a
 *   server-side proxy (e.g., Vercel Edge Function, Cloudflare Worker)
 *   that holds the token and forwards the request.
 *
 * TODO: Add server-side proxy for production deployment.
 * TODO: Add rate limiting to prevent abuse.
 * TODO: Attach device/browser info automatically.
 * TODO: Support image attachments (screenshots).
 */

import { createLogger } from '../core/logger'

const log = createLogger('FEEDBACK')

// ─── Configuration ──────────────────────────────────────────────────────────

/** GitHub repo owner/name — issues are created here */
const GITHUB_OWNER = 'krooney144'
const GITHUB_REPO  = 'EarthContours_v1'

/** GitHub API endpoint for creating issues */
const GITHUB_ISSUES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`

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
 * Submit user feedback as a GitHub Issue.
 *
 * The issue is created with:
 *   - Title: first 80 chars of the feedback text
 *   - Body: full feedback + device info
 *   - Label: "user-feedback" (created automatically if it doesn't exist)
 *
 * @param feedbackText - The user's feedback message
 * @returns Result with success status and issue URL or error
 */
export async function submitFeedback(feedbackText: string): Promise<FeedbackResult> {
  const token = import.meta.env.VITE_GITHUB_TOKEN as string | undefined

  if (!token) {
    log.warn('No GitHub token configured — feedback cannot be submitted')
    return {
      success: false,
      error: 'GitHub token not configured. Add VITE_GITHUB_TOKEN to .env.local',
    }
  }

  // Build the issue title from the first line / 80 chars
  const firstLine = feedbackText.split('\n')[0].trim()
  const title = `[Feedback] ${firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine}`

  // Build the issue body with device info
  const body = [
    '## User Feedback',
    '',
    feedbackText,
    '',
    '---',
    '',
    '## Device Info',
    '',
    getDeviceInfo(),
    '',
    `*Submitted from EarthContours v1 at ${new Date().toISOString()}*`,
  ].join('\n')

  log.info('Submitting feedback to GitHub', { titleLength: title.length, bodyLength: body.length })

  try {
    const response = await fetch(GITHUB_ISSUES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['user-feedback'],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('GitHub API error', { status: response.status, body: errorText })

      // Common error cases
      if (response.status === 401) {
        return { success: false, error: 'Invalid GitHub token — check VITE_GITHUB_TOKEN' }
      }
      if (response.status === 403) {
        return { success: false, error: 'GitHub token lacks permission to create issues' }
      }
      if (response.status === 422) {
        return { success: false, error: 'GitHub rejected the issue — check repo access' }
      }

      return { success: false, error: `GitHub API error (${response.status})` }
    }

    const data = await response.json()
    const issueUrl = data.html_url as string

    log.info('Feedback submitted successfully', { issueUrl, issueNumber: data.number })

    return { success: true, issueUrl }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Failed to submit feedback', { error: message })

    return {
      success: false,
      error: `Network error: ${message}`,
    }
  }
}
