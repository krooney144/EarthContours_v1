/**
 * Download Natural Earth 10m GeoJSON data files.
 *
 * Source: https://github.com/martynafford/natural-earth-geojson
 * License: CC0 (public domain)
 *
 * Downloads three files into /public/geo/:
 *   - rivers.json  (ne_10m_rivers_lake_centerlines)
 *   - lakes.json   (ne_10m_lakes)
 *   - glaciers.json (ne_10m_glaciated_areas)
 *
 * Usage: node scripts/processGeoData.mjs
 */

import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GEO_DIR = join(__dirname, '..', 'public', 'geo')

const BASE_URL = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/physical'

const FILES = [
  { remote: 'ne_10m_rivers_lake_centerlines.json', local: 'rivers.json' },
  { remote: 'ne_10m_lakes.json',                   local: 'lakes.json' },
  { remote: 'ne_10m_glaciated_areas.json',         local: 'glaciers.json' },
]

async function download(remote, local) {
  const outPath = join(GEO_DIR, local)

  if (existsSync(outPath)) {
    console.log(`  ✓ ${local} already exists, skipping`)
    return
  }

  const url = `${BASE_URL}/${remote}`
  console.log(`  ↓ Downloading ${remote} ...`)

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }

  const text = await res.text()
  writeFileSync(outPath, text, 'utf-8')

  const sizeMB = (Buffer.byteLength(text, 'utf-8') / (1024 * 1024)).toFixed(1)
  console.log(`  ✓ ${local} saved (${sizeMB} MB)`)
}

async function main() {
  console.log('Natural Earth 10m GeoJSON downloader')
  console.log(`Output: ${GEO_DIR}\n`)

  for (const { remote, local } of FILES) {
    await download(remote, local)
  }

  console.log('\nDone! All files saved to public/geo/')
}

main().catch((err) => {
  console.error('Download failed:', err.message)
  process.exit(1)
})
