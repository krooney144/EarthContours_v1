/**
 * Download Natural Earth GeoJSON data files (v5.1.2).
 *
 * Source: https://github.com/nvkelso/natural-earth-vector (official repo)
 * License: Public domain
 *
 * Downloads 6 files into /public/geo/:
 *   - rivers.json             (ne_10m_rivers_lake_centerlines)
 *   - lakes.json              (ne_10m_lakes)
 *   - glaciers.json           (ne_10m_glaciated_areas)
 *   - coastline.json          (ne_10m_coastline)
 *   - ocean.json              (ne_50m_ocean)
 *   - antarctic_ice_shelves.json (ne_10m_antarctic_ice_shelves_polys)
 *
 * Usage: node scripts/processGeoData.mjs
 *        node scripts/processGeoData.mjs --force   (re-download all)
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GEO_DIR = join(__dirname, '..', 'public', 'geo')

const BASE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'

const FILES = [
  { remote: 'ne_10m_rivers_lake_centerlines.geojson', local: 'rivers.json' },
  { remote: 'ne_10m_lakes.geojson',                   local: 'lakes.json' },
  { remote: 'ne_10m_glaciated_areas.geojson',          local: 'glaciers.json' },
  { remote: 'ne_10m_coastline.geojson',                local: 'coastline.json' },
  { remote: 'ne_50m_ocean.geojson',                    local: 'ocean.json' },
  { remote: 'ne_10m_antarctic_ice_shelves_polys.geojson', local: 'antarctic_ice_shelves.json' },
]

const force = process.argv.includes('--force')

async function download(remote, local) {
  const outPath = join(GEO_DIR, local)

  if (!force && existsSync(outPath)) {
    console.log(`  ✓ ${local} already exists, skipping (use --force to re-download)`)
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
  console.log('Natural Earth GeoJSON downloader (v5.1.2 from nvkelso/natural-earth-vector)')
  console.log(`Output: ${GEO_DIR}\n`)

  mkdirSync(GEO_DIR, { recursive: true })

  for (const { remote, local } of FILES) {
    await download(remote, local)
  }

  console.log('\nDone! All files saved to public/geo/')
}

main().catch((err) => {
  console.error('Download failed:', err.message)
  process.exit(1)
})
