/**
 * EarthContours — Feedback API Route (Vercel Serverless Function)
 *
 * Proxies feedback submissions to GitHub Issues so the token stays server-side.
 * The client sends { text: "..." } and this function creates the issue.
 *
 * Environment variable (set in Vercel dashboard, NOT prefixed with VITE_):
 *   GITHUB_TOKEN — GitHub PAT with `public_repo` scope
 *
 * Endpoint: POST /api/feedback
 * Body: { "text": "User's feedback message" }
 * Response: { "success": true, "issueUrl": "..." } or { "success": false, "error": "..." }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const GITHUB_OWNER = 'krooney144'
const GITHUB_REPO  = 'EarthContours_v1'
const GITHUB_ISSUES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return res.status(500).json({ success: false, error: 'Server misconfigured — no GitHub token' })
  }

  const { text, deviceInfo } = req.body ?? {}
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Feedback text is required' })
  }

  // Build issue title from first line / 80 chars
  const firstLine = text.split('\n')[0].trim()
  const title = `[Feedback] ${firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine}`

  // Build issue body
  const body = [
    '## User Feedback',
    '',
    text,
    '',
    '---',
    '',
    '## Device Info',
    '',
    typeof deviceInfo === 'string' ? deviceInfo : '_Not provided_',
    '',
    `*Submitted from EarthContours v1 at ${new Date().toISOString()}*`,
  ].join('\n')

  try {
    const response = await fetch(GITHUB_ISSUES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels: ['user-feedback'] }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('GitHub API error', { status: response.status, body: errText })
      return res.status(502).json({ success: false, error: `GitHub API error (${response.status})` })
    }

    const data = await response.json()
    return res.status(200).json({ success: true, issueUrl: data.html_url })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Failed to create GitHub issue', message)
    return res.status(502).json({ success: false, error: `Network error: ${message}` })
  }
}
