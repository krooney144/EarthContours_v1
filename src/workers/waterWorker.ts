/// <reference lib="webworker" />

/**
 * EarthContours — Water Feature Web Worker
 *
 * Off-loads Overpass API fetching, JSON parsing, multipolygon stitching,
 * and river stitching to a background thread so the MAP screen stays
 * responsive.
 *
 * ── Architecture ─────────────────────────────────────────────────────
 *
 *  Tile-based:  The world is divided into a grid (step size set by main
 *  thread per request).  Each tile is fetched independently, cached in
 *  IndexedDB with a 24-hour TTL, and sent back individually.
 *
 *  Messages IN:
 *    { type: 'fetch-tiles', tiles: WaterTileRequest[], generation: number }
 *
 *  Messages OUT:
 *    { type: 'tile-result', key, lakes, rivers, fromCache, fetchMs, generation }
 *    { type: 'all-complete', generation, stats }
 *    { type: 'error', key, error, generation }
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME      = 'ec-water-tiles-v1'
const STORE_NAME   = 'tiles'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 h
const MAX_CONCURRENT = 2  // max simultaneous Overpass requests

// ─── Types ──────────────────────────────────────────────────────────────────

interface LatLng { lat: number; lng: number }

interface WaterBody {
  id: string
  name: string
  type: 'lake' | 'reservoir' | 'pond' | 'water'
  center: LatLng
  polygon: LatLng[]
  innerRings?: LatLng[][]
}

interface River {
  id: string
  name: string
  points: LatLng[]
}

interface WaterTileRequest {
  key: string
  south: number
  west: number
  north: number
  east: number
}

interface TileResult {
  lakes: WaterBody[]
  rivers: River[]
}

interface OverpassGeomNode { lat: number; lon: number }

interface OverpassElement {
  type: string
  id:   number
  tags?: Record<string, string>
  geometry?: OverpassGeomNode[]
  members?: Array<{ type: string; ref: number; role: string; geometry?: OverpassGeomNode[] }>
}

// ─── IndexedDB Cache ────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
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

interface CachedTile { data: TileResult; timestamp: number }

async function getCached(key: string): Promise<TileResult | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx  = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => {
        const entry = req.result as CachedTile | undefined
        if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) {
          resolve(null)
        } else {
          resolve(entry.data)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveCache(key: string, data: TileResult): Promise<void> {
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

// ─── In-memory tile cache ───────────────────────────────────────────────────

const memCache = new Map<string, TileResult>()

// ─── Geometry Helpers ───────────────────────────────────────────────────────

function classifyWater(tags: Record<string, string>): WaterBody['type'] {
  const w = tags.water ?? ''
  if (w === 'reservoir' || tags.landuse === 'reservoir') return 'reservoir'
  if (w === 'pond') return 'pond'
  if (w === 'lake') return 'lake'
  return 'water'
}

function centroid(pts: LatLng[]): LatLng {
  let lat = 0, lng = 0
  for (const p of pts) { lat += p.lat; lng += p.lng }
  return { lat: lat / pts.length, lng: lng / pts.length }
}

function haversineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng
  return 2 * R * Math.asin(Math.sqrt(h))
}

function pathLengthM(pts: LatLng[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += haversineM(pts[i - 1], pts[i])
  return len
}

// ─── Multipolygon Stitching ─────────────────────────────────────────────────

function stitchSegmentsToRings(segments: LatLng[][]): LatLng[][] {
  if (segments.length === 0) return []
  const TOLERANCE_M = 50
  const remaining = segments.map(s => ({ pts: [...s], used: false }))
  const rings: LatLng[][] = []

  for (let startIdx = 0; startIdx < remaining.length; startIdx++) {
    if (remaining[startIdx].used) continue
    remaining[startIdx].used = true
    const ring = [...remaining[startIdx].pts]
    let changed = true

    while (changed) {
      changed = false
      const ringEnd = ring[ring.length - 1]
      const ringStart = ring[0]
      if (ring.length > 3 && haversineM(ringStart, ringEnd) < TOLERANCE_M) break

      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].used) continue
        const seg = remaining[i].pts
        const segStart = seg[0]
        const segEnd = seg[seg.length - 1]

        if (haversineM(ringEnd, segStart) < TOLERANCE_M) {
          ring.push(...seg.slice(1))
          remaining[i].used = true; changed = true; break
        }
        if (haversineM(ringEnd, segEnd) < TOLERANCE_M) {
          ring.push(...seg.slice(0, -1).reverse())
          remaining[i].used = true; changed = true; break
        }
      }
    }
    if (ring.length >= 4) rings.push(ring)
  }
  return rings
}

function parseMultipolygon(el: OverpassElement): { outer: LatLng[][]; inner: LatLng[][] } {
  const outerSegs: LatLng[][] = []
  const innerSegs: LatLng[][] = []
  if (!el.members) return { outer: [], inner: [] }

  for (const m of el.members) {
    if (!m.geometry || m.geometry.length < 2) continue
    const pts = m.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
    if (m.role === 'outer' || m.role === '') outerSegs.push(pts)
    else if (m.role === 'inner') innerSegs.push(pts)
  }

  return {
    outer: stitchSegmentsToRings(outerSegs),
    inner: stitchSegmentsToRings(innerSegs),
  }
}

// ─── River Stitching ────────────────────────────────────────────────────────

interface RawRiverSegment { id: string; name: string; points: LatLng[]; isStream: boolean }

function stitchRivers(segments: RawRiverSegment[]): (River & { _isStream: boolean })[] {
  const TOLERANCE_M = 15
  const byName = new Map<string, RawRiverSegment[]>()
  for (const seg of segments) {
    const key = seg.name.toLowerCase().trim()
    const group = byName.get(key) ?? []
    group.push(seg)
    byName.set(key, group)
  }

  const result: (River & { _isStream: boolean })[] = []

  for (const [, group] of byName) {
    const allStream = group.every(s => s.isStream)

    if (group.length === 1) {
      result.push({ id: group[0].id, name: group[0].name, points: group[0].points, _isStream: group[0].isStream })
      continue
    }

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

          if (haversineM(chainEnd, segStart) < TOLERANCE_M) {
            chain.push(...seg.slice(1)); remaining[i].used = true; changed = true; break
          }
          if (haversineM(chainEnd, segEnd) < TOLERANCE_M) {
            chain.push(...[...seg].reverse().slice(1)); remaining[i].used = true; changed = true; break
          }
          if (haversineM(chainStart, segStart) < TOLERANCE_M) {
            chain.unshift(...[...seg].reverse().slice(0, -1)); remaining[i].used = true; changed = true; break
          }
          if (haversineM(chainStart, segEnd) < TOLERANCE_M) {
            chain.unshift(...seg.slice(0, -1)); remaining[i].used = true; changed = true; break
          }
        }
      }

      if (chain.length >= 2) {
        result.push({ id: `osm-river-${remaining[startIdx].id}`, name: remaining[startIdx].name, points: chain, _isStream: allStream })
      }
    }
  }
  return result
}

// ─── Overpass Fetch + Parse (per tile) ──────────────────────────────────────

async function fetchTile(tile: WaterTileRequest): Promise<{ result: TileResult; fromCache: boolean; fetchMs: number }> {
  // 1. In-memory cache
  const mem = memCache.get(tile.key)
  if (mem) return { result: mem, fromCache: true, fetchMs: 0 }

  // 2. IndexedDB cache
  const cached = await getCached(tile.key)
  if (cached) {
    memCache.set(tile.key, cached)
    return { result: cached, fromCache: true, fetchMs: 0 }
  }

  // 3. Overpass fetch
  const t0 = performance.now()
  const bbox = `${tile.south},${tile.west},${tile.north},${tile.east}`

  // Simplified unified query — all named water features in one shot
  const query = `[out:json][timeout:60];
(
  way["natural"="water"]["name"](${bbox});
  relation["natural"="water"]["name"](${bbox});
  way["water"]["name"](${bbox});
  relation["water"]["name"](${bbox});
  way["waterway"]["name"](${bbox});
);
out geom;`

  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  })
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`)

  const data = await resp.json() as { elements: OverpassElement[] }
  const fetchMs = performance.now() - t0

  // Parse elements
  const lakes: WaterBody[] = []
  const riverSegments: RawRiverSegment[] = []

  for (const el of data.elements) {
    const tags = el.tags
    if (!tags?.name) continue

    // Waterway segments → rivers
    if (tags.waterway) {
      if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
        riverSegments.push({
          id: `w${el.id}`,
          name: tags.name,
          points: el.geometry.map(g => ({ lat: g.lat, lng: g.lon })),
          isStream: tags.waterway === 'stream',
        })
      }
      continue
    }

    // Water body polygons (ways and relations)
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      const polygon = el.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
      lakes.push({
        id: `osm-w${el.id}`,
        name: tags.name,
        type: classifyWater(tags),
        center: centroid(polygon),
        polygon,
      })
    } else if (el.type === 'relation' && el.members) {
      const { outer, inner } = parseMultipolygon(el)
      if (outer.length === 0) continue
      outer.sort((a, b) => b.length - a.length)

      for (let i = 0; i < outer.length; i++) {
        const ring = outer[i]
        if (ring.length < 4) continue
        const relevantInner = i === 0 ? inner : []
        lakes.push({
          id: `osm-r${el.id}${i > 0 ? `-${i}` : ''}`,
          name: tags.name,
          type: classifyWater(tags),
          center: centroid(ring),
          polygon: ring,
          innerRings: relevantInner.length > 0 ? relevantInner : undefined,
        })
      }
    }
  }

  // Stitch rivers
  const stitched = stitchRivers(riverSegments)
  const rivers: River[] = stitched
    .filter(r => !r._isStream || pathLengthM(r.points) >= 2000)
    .map(({ _isStream: _, ...river }) => river)

  // Sort lakes by polygon size
  lakes.sort((a, b) => b.polygon.length - a.polygon.length)

  const result: TileResult = { lakes, rivers }

  // Cache
  memCache.set(tile.key, result)
  await saveCache(tile.key, result)

  return { result, fromCache: false, fetchMs }
}

// ─── Concurrency-Limited Tile Fetcher ───────────────────────────────────────

async function fetchAllTiles(
  tiles: WaterTileRequest[],
  generation: number,
): Promise<void> {
  let completed = 0
  let cached = 0
  let fetched = 0
  let totalFetchMs = 0
  let totalLakes = 0
  let totalRivers = 0

  // Process tiles with concurrency limit
  const queue = [...tiles]
  const active: Promise<void>[] = []

  const processNext = async (): Promise<void> => {
    while (queue.length > 0) {
      const tile = queue.shift()!
      try {
        const { result, fromCache, fetchMs } = await fetchTile(tile)
        completed++
        if (fromCache) cached++
        else { fetched++; totalFetchMs += fetchMs }
        totalLakes += result.lakes.length
        totalRivers += result.rivers.length

        self.postMessage({
          type: 'tile-result',
          key: tile.key,
          lakes: result.lakes,
          rivers: result.rivers,
          fromCache,
          fetchMs: Math.round(fetchMs),
          generation,
        })
      } catch (err) {
        completed++
        self.postMessage({
          type: 'error',
          key: tile.key,
          error: String(err),
          generation,
        })
      }
    }
  }

  // Launch MAX_CONCURRENT workers
  for (let i = 0; i < Math.min(MAX_CONCURRENT, tiles.length); i++) {
    active.push(processNext())
  }
  await Promise.all(active)

  self.postMessage({
    type: 'all-complete',
    generation,
    stats: {
      totalTiles: tiles.length,
      cached,
      fetched,
      totalFetchMs: Math.round(totalFetchMs),
      totalLakes,
      totalRivers,
    },
  })
}

// ─── Message Handler ────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data

  if (type === 'fetch-tiles') {
    const { tiles, generation } = e.data as {
      tiles: WaterTileRequest[]
      generation: number
    }
    fetchAllTiles(tiles, generation)
  }
}
