/**
 * EarthContours — OpenStreetMap Water Feature Loader
 *
 * Unified fetcher for lakes AND rivers AND streams from OSM's Overpass API.
 * One function, one query, one cache entry per location.
 * Called by MAP, EXPLORE, and SCAN screens identically.
 *
 * Pattern mirrors peakLoader.ts exactly:
 *   fetchWaterNear(lat, lng, radiusKm) → { lakes, rivers }
 *
 * Cache strategy:
 *   - Results stored in IndexedDB keyed by rounded lat/lng string.
 *   - Cache TTL is 24 hours.
 *   - On Overpass failure returns empty arrays — callers degrade gracefully.
 *
 * Single Overpass query fetches:
 *   - way/relation["natural"="water"]["name"]         → lakes, reservoirs, ponds
 *   - way["waterway"="river"]["name"]                 → rivers
 *   - way["waterway"="stream"]["name"]                → named streams (filtered ≥2km)
 *
 * Post-processing:
 *   - Multipolygon relations: ALL outer members stitched, inner rings preserved
 *   - River segments: same-named ways stitched by endpoint matching (~10m tolerance)
 *   - Streams: filtered by path length ≥ 2km
 */

import { createLogger } from '../core/logger'
import type { WaterBody, River, LatLng } from '../core/types'

const log = createLogger('DATA:WATER_LOADER')

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME      = 'ec-water-v4'
const STORE_NAME   = 'water'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 h

// ─── Result Type ─────────────────────────────────────────────────────────────

export interface WaterNearResult {
  lakes:  WaterBody[]
  rivers: River[]
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null

async function openDB(): Promise<IDBDatabase> {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = (e) => { _db = (e.target as IDBOpenDBRequest).result; resolve(_db) }
    req.onerror   = ()  => reject(new Error('Water IDB unavailable'))
  })
}

interface CachedEntry { data: WaterNearResult; timestamp: number }

async function getCached(key: string): Promise<WaterNearResult | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx  = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => {
        const entry = req.result as CachedEntry | undefined
        if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) {
          resolve(null)
        } else {
          log.info('Water cache hit', { key, lakes: entry.data.lakes.length, rivers: entry.data.rivers.length })
          resolve(entry.data)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveCache(key: string, data: WaterNearResult): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ data, timestamp: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* non-fatal */ }
}

// ─── In-flight Dedup ─────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<WaterNearResult>>()

// ─── Overpass Types ──────────────────────────────────────────────────────────

interface OverpassGeomNode {
  lat: number
  lon: number
}

interface OverpassElement {
  type: string
  id:   number
  tags?: Record<string, string>
  geometry?: OverpassGeomNode[]
  members?: Array<{ type: string; ref: number; role: string; geometry?: OverpassGeomNode[] }>
}

interface OverpassResponse {
  elements: OverpassElement[]
}

// ─── Geometry Helpers ────────────────────────────────────────────────────────

/** Classify water body type from OSM tags */
function classifyWater(tags: Record<string, string>): WaterBody['type'] {
  const w = tags.water ?? ''
  if (w === 'reservoir' || tags.landuse === 'reservoir') return 'reservoir'
  if (w === 'pond') return 'pond'
  if (w === 'lake') return 'lake'
  return 'water'
}

/** Compute centroid of a polygon (simple average) */
function centroid(pts: LatLng[]): LatLng {
  let lat = 0, lng = 0
  for (const p of pts) { lat += p.lat; lng += p.lng }
  return { lat: lat / pts.length, lng: lng / pts.length }
}

/** Haversine distance between two lat/lng points in metres */
function haversineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Compute total path length of a LatLng array in metres */
function pathLengthM(pts: LatLng[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    len += haversineM(pts[i - 1], pts[i])
  }
  return len
}

// ─── Multipolygon Stitching ─────────────────────────────────────────────────

/**
 * Stitch an array of open linestring segments into closed rings.
 * Each segment is an array of LatLng. We match endpoints within a tolerance
 * and chain segments together until rings close.
 */
function stitchSegmentsToRings(segments: LatLng[][]): LatLng[][] {
  if (segments.length === 0) return []

  const TOLERANCE_M = 50  // 50m endpoint matching tolerance
  const remaining = segments.map(s => ({ pts: [...s], used: false }))
  const rings: LatLng[][] = []

  for (let startIdx = 0; startIdx < remaining.length; startIdx++) {
    if (remaining[startIdx].used) continue
    remaining[startIdx].used = true

    const ring = [...remaining[startIdx].pts]
    let changed = true

    // Keep trying to extend the ring until no more segments match
    while (changed) {
      changed = false
      const ringEnd = ring[ring.length - 1]
      const ringStart = ring[0]

      // Check if ring is already closed
      if (ring.length > 3 && haversineM(ringStart, ringEnd) < TOLERANCE_M) {
        break
      }

      // Try to find a segment that connects to the end of our ring
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].used) continue
        const seg = remaining[i].pts
        const segStart = seg[0]
        const segEnd = seg[seg.length - 1]

        // Try forward: seg start matches ring end
        if (haversineM(ringEnd, segStart) < TOLERANCE_M) {
          ring.push(...seg.slice(1))  // skip first point (duplicate)
          remaining[i].used = true
          changed = true
          break
        }
        // Try reversed: seg end matches ring end
        if (haversineM(ringEnd, segEnd) < TOLERANCE_M) {
          ring.push(...seg.slice(0, -1).reverse())  // reverse and skip last (now first)
          remaining[i].used = true
          changed = true
          break
        }
      }
    }

    if (ring.length >= 4) {
      rings.push(ring)
    }
  }

  return rings
}

/**
 * Parse an OSM multipolygon relation into outer ring(s) and inner ring(s).
 * Handles relations like Lake Mead where the outer boundary is split across
 * many way members that must be stitched together.
 */
function parseMultipolygon(el: OverpassElement): { outer: LatLng[][]; inner: LatLng[][] } {
  const outerSegs: LatLng[][] = []
  const innerSegs: LatLng[][] = []

  if (!el.members) return { outer: [], inner: [] }

  for (const m of el.members) {
    if (!m.geometry || m.geometry.length < 2) continue
    const pts = m.geometry.map(g => ({ lat: g.lat, lng: g.lon }))

    if (m.role === 'outer') {
      outerSegs.push(pts)
    } else if (m.role === 'inner') {
      innerSegs.push(pts)
    }
  }

  return {
    outer: stitchSegmentsToRings(outerSegs),
    inner: stitchSegmentsToRings(innerSegs),
  }
}

// ─── River Stitching ────────────────────────────────────────────────────────

interface RawRiverSegment {
  id: string
  name: string
  points: LatLng[]
  isStream: boolean  // true for waterway=stream, false for waterway=river
}

/**
 * Stitch same-named river/stream way segments into continuous polylines.
 * Groups by name, then chains segments by matching endpoints (~10m tolerance).
 * A single named river may produce multiple polylines if there are disconnected
 * branches (tributaries with the same name).
 * Returns rivers with an `_isStream` flag for post-filtering.
 */
function stitchRivers(segments: RawRiverSegment[]): (River & { _isStream: boolean })[] {
  const TOLERANCE_M = 15  // 15m endpoint matching tolerance

  // Group segments by name
  const byName = new Map<string, RawRiverSegment[]>()
  for (const seg of segments) {
    const key = seg.name.toLowerCase().trim()
    const group = byName.get(key) ?? []
    group.push(seg)
    byName.set(key, group)
  }

  const result: (River & { _isStream: boolean })[] = []

  for (const [, group] of byName) {
    // A stitched group is a "stream" only if ALL segments are streams
    const allStream = group.every(s => s.isStream)

    // For single-segment rivers, just pass through
    if (group.length === 1) {
      result.push({
        id: group[0].id,
        name: group[0].name,
        points: group[0].points,
        _isStream: group[0].isStream,
      })
      continue
    }

    // Stitch multiple segments by endpoint matching
    const remaining = group.map(s => ({ ...s, used: false }))

    for (let startIdx = 0; startIdx < remaining.length; startIdx++) {
      if (remaining[startIdx].used) continue
      remaining[startIdx].used = true

      const chain: LatLng[] = [...remaining[startIdx].points]
      let changed = true

      while (changed) {
        changed = false
        const chainStart = chain[0]
        const chainEnd = chain[chain.length - 1]

        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i].used) continue
          const seg = remaining[i].points
          const segStart = seg[0]
          const segEnd = seg[seg.length - 1]

          // seg start → chain end (forward append)
          if (haversineM(chainEnd, segStart) < TOLERANCE_M) {
            chain.push(...seg.slice(1))
            remaining[i].used = true
            changed = true
            break
          }
          // seg end → chain end (reverse append)
          if (haversineM(chainEnd, segEnd) < TOLERANCE_M) {
            const reversed = [...seg].reverse()
            chain.push(...reversed.slice(1))
            remaining[i].used = true
            changed = true
            break
          }
          // seg end → chain start (forward prepend)
          if (haversineM(chainStart, segStart) < TOLERANCE_M) {
            const reversed = [...seg].reverse()
            chain.unshift(...reversed.slice(0, -1))
            remaining[i].used = true
            changed = true
            break
          }
          // seg start → chain start (reverse prepend)
          if (haversineM(chainStart, segEnd) < TOLERANCE_M) {
            chain.unshift(...seg.slice(0, -1))
            remaining[i].used = true
            changed = true
            break
          }
        }
      }

      if (chain.length >= 2) {
        result.push({
          id: `osm-river-${remaining[startIdx].id}`,
          name: remaining[startIdx].name,
          points: chain,
          _isStream: allStream,
        })
      }
    }
  }

  return result
}

// ─── Overpass Fetching ────────────────────────────────────────────────────────

/** Core fetch: lakes + rivers + streams in a bounding box, one Overpass query */
async function fetchWaterInBounds(
  south: number, west: number, north: number, east: number,
): Promise<WaterNearResult> {
  // Rounded cache key — same pattern as peakLoader
  const key = `${south.toFixed(1)},${west.toFixed(1)},${north.toFixed(1)},${east.toFixed(1)}`

  // In-flight dedup
  const existing = inFlight.get(key)
  if (existing) return existing

  const doFetch = async (): Promise<WaterNearResult> => {
    // IndexedDB cache
    const cached = await getCached(key)
    if (cached) return cached

    // Single Overpass query: lakes + rivers + named streams
    const bbox = `${south},${west},${north},${east}`
    const query = `[out:json][timeout:90];
(
  way["natural"="water"]["name"](${bbox});
  relation["natural"="water"]["name"](${bbox});
  way["waterway"="river"]["name"](${bbox});
  way["waterway"="stream"]["name"](${bbox});
);
out geom;`

    log.info('Fetching water features from Overpass', { south: south.toFixed(1), west: west.toFixed(1), north: north.toFixed(1), east: east.toFixed(1) })

    try {
      const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
      })
      if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`)

      const data = (await resp.json()) as OverpassResponse

      const lakes:  WaterBody[]       = []
      const riverSegments: RawRiverSegment[] = []

      for (const el of data.elements) {
        const tags = el.tags
        if (!tags?.name) continue

        // ── River or Stream segments (collected for stitching) ──────────
        if (tags.waterway === 'river' || tags.waterway === 'stream') {
          if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
            riverSegments.push({
              id:       `w${el.id}`,
              name:     tags.name,
              points:   el.geometry.map(g => ({ lat: g.lat, lng: g.lon })),
              isStream: tags.waterway === 'stream',
            })
          }
          continue
        }

        // ── Lake/reservoir/pond (natural=water) ────────────────────────
        if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
          // Simple way — single polygon ring
          const polygon = el.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
          lakes.push({
            id:      `osm-w${el.id}`,
            name:    tags.name,
            type:    classifyWater(tags),
            center:  centroid(polygon),
            polygon,
          })
        } else if (el.type === 'relation' && el.members) {
          // Multipolygon relation — stitch ALL outer members, preserve inner rings
          const { outer, inner } = parseMultipolygon(el)
          if (outer.length === 0) continue

          // Use the largest outer ring as the main polygon
          outer.sort((a, b) => b.length - a.length)
          const mainPolygon = outer[0]

          if (mainPolygon.length < 4) continue

          // Additional outer rings become separate water bodies (e.g. disconnected arms)
          for (let i = 0; i < outer.length; i++) {
            const ring = outer[i]
            if (ring.length < 4) continue

            // Inner rings that fall within this outer ring
            const relevantInner = i === 0 ? inner : []

            lakes.push({
              id:         `osm-r${el.id}${i > 0 ? `-${i}` : ''}`,
              name:       tags.name,
              type:       classifyWater(tags),
              center:     centroid(ring),
              polygon:    ring,
              innerRings: relevantInner.length > 0 ? relevantInner : undefined,
            })
          }
        }
      }

      // ── Stitch river/stream segments by name ───────────────────────────
      const stitched = stitchRivers(riverSegments)

      // ── Filter: rivers always kept; streams must be ≥ 2km ─────────────
      const rivers: River[] = stitched
        .filter(r => !r._isStream || pathLengthM(r.points) >= 2000)
        .map(({ _isStream: _, ...river }) => river)  // strip internal flag

      // Sort lakes by polygon size (largest first) for rendering priority
      lakes.sort((a, b) => b.polygon.length - a.polygon.length)

      const result: WaterNearResult = { lakes, rivers }
      log.info('Water features fetched', {
        lakes: lakes.length,
        riverSegments: riverSegments.length,
        stitchedRivers: rivers.length,
        key,
      })
      await saveCache(key, result)
      return result
    } catch (err) {
      log.warn('Water fetch failed', { err: String(err) })
      return { lakes: [], rivers: [] }
    }
  }

  const promise = doFetch().finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all named water features (lakes + rivers + streams ≥2km) within `radiusKm` of a point.
 * One Overpass query, one cache entry. Called identically by MAP, EXPLORE, SCAN.
 *
 * @param lat       Center latitude
 * @param lng       Center longitude
 * @param radiusKm  Search radius in kilometres (typically 300)
 * @returns { lakes: WaterBody[], rivers: River[] }
 */
export async function fetchWaterNear(
  lat: number, lng: number, radiusKm: number,
): Promise<WaterNearResult> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)
  return fetchWaterInBounds(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
}
