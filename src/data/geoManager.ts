/**
 * EarthContours — GeoJSON → App Types Converter
 *
 * Converts Natural Earth GeoJSON FeatureCollections into the app's
 * River[], WaterBody[], and Glacier[] types.
 *
 * All zoom-based filtering (which features appear at which zoom,
 * label sizes, line thickness) is purely rendering logic in MapScreen —
 * this module returns ALL features and lets the renderer decide.
 */

import type { River, WaterBody, Glacier, GlacierType, Coastline, LatLng } from '../core/types'
import { loadGeoLayer } from './geoLoader'
import type { GeoJSONFeature } from './geoLoader'
import { createLogger } from '../core/logger'

const log = createLogger('GEO:MANAGER')

// ─── Coordinate Helpers ──────────────────────────────────────────────────────

/** Convert [lng, lat] GeoJSON coordinate to LatLng */
function toLatLng(coord: [number, number]): LatLng {
  return { lat: coord[1], lng: coord[0] }
}

/** Compute the centroid of a polygon ring */
function centroid(ring: [number, number][]): LatLng {
  let sumLat = 0, sumLng = 0
  for (const [lng, lat] of ring) {
    sumLat += lat
    sumLng += lng
  }
  return { lat: sumLat / ring.length, lng: sumLng / ring.length }
}

// ─── River Conversion ────────────────────────────────────────────────────────

function featureToRivers(feature: GeoJSONFeature, index: number): River[] {
  const props = feature.properties
  const name = (props.name as string) ?? ''
  const scalerank = (props.scalerank as number) ?? 10
  const geom = feature.geometry

  if (geom.type === 'LineString') {
    const coords = geom.coordinates as [number, number][]
    return [{
      id: `ne-river-${index}`,
      name,
      points: coords.map(toLatLng),
      isStream: scalerank >= 7,
      scalerank,
    }]
  }

  if (geom.type === 'MultiLineString') {
    const lines = geom.coordinates as [number, number][][]
    return lines.map((coords, li) => ({
      id: `ne-river-${index}-${li}`,
      name,
      points: coords.map(toLatLng),
      isStream: scalerank >= 7,
      scalerank,
    }))
  }

  return []
}

// ─── Lake Conversion ─────────────────────────────────────────────────────────

function featureToWaterBody(feature: GeoJSONFeature, index: number): WaterBody | null {
  const props = feature.properties
  const name = (props.name as string) ?? ''
  const featurecla = (props.featurecla as string) ?? 'Lake'
  const scalerank = (props.scalerank as number) ?? 10
  const geom = feature.geometry

  const type: WaterBody['type'] =
    featurecla === 'Reservoir' ? 'reservoir' :
    featurecla === 'Alkaline Lake' ? 'alkaline' :
    'lake'

  if (geom.type === 'Polygon') {
    const rings = geom.coordinates as [number, number][][]
    const outerRing = rings[0]
    const innerRings = rings.length > 1 ? rings.slice(1).map(r => r.map(toLatLng)) : undefined

    return {
      id: `ne-lake-${index}`,
      name,
      type,
      center: centroid(outerRing),
      polygon: outerRing.map(toLatLng),
      innerRings,
      scalerank,
    }
  }

  if (geom.type === 'MultiPolygon') {
    // Use the largest polygon (first one) as the primary shape
    const multiPolys = geom.coordinates as [number, number][][][]
    const outerRing = multiPolys[0][0]
    const innerRings: LatLng[][] = []

    // Collect inner rings from first polygon
    for (let i = 1; i < multiPolys[0].length; i++) {
      innerRings.push(multiPolys[0][i].map(toLatLng))
    }
    // Additional polygons treated as separate outer shapes (add as inner rings for rendering)
    for (let p = 1; p < multiPolys.length; p++) {
      // These are separate polygons of the same lake — not inner rings
      // For simplicity, we skip them (the largest polygon is sufficient for display)
    }

    return {
      id: `ne-lake-${index}`,
      name,
      type,
      center: centroid(outerRing),
      polygon: outerRing.map(toLatLng),
      innerRings: innerRings.length > 0 ? innerRings : undefined,
      scalerank,
    }
  }

  return null
}

// ─── Glacier Conversion ──────────────────────────────────────────────────────

function classifyGlacier(scalerank: number): GlacierType {
  if (scalerank === 0) return 'ice_sheet'
  if (scalerank <= 1) return 'ice_cap'
  return 'glacier'
}

function featureToGlacier(feature: GeoJSONFeature, index: number): Glacier | null {
  const props = feature.properties
  const name = (props.name as string) ?? ''
  const scalerank = (props.scalerank as number) ?? 6
  const geom = feature.geometry

  const type = classifyGlacier(scalerank)

  if (geom.type === 'Polygon') {
    const rings = geom.coordinates as [number, number][][]
    const outerRing = rings[0]
    const innerRings = rings.length > 1 ? rings.slice(1).map(r => r.map(toLatLng)) : undefined

    return {
      id: `ne-glacier-${index}`,
      name,
      type,
      center: centroid(outerRing),
      polygon: outerRing.map(toLatLng),
      innerRings,
      scalerank,
    }
  }

  if (geom.type === 'MultiPolygon') {
    const multiPolys = geom.coordinates as [number, number][][][]
    const outerRing = multiPolys[0][0]
    const innerRings: LatLng[][] = []
    for (let i = 1; i < multiPolys[0].length; i++) {
      innerRings.push(multiPolys[0][i].map(toLatLng))
    }

    return {
      id: `ne-glacier-${index}`,
      name,
      type,
      center: centroid(outerRing),
      polygon: outerRing.map(toLatLng),
      innerRings: innerRings.length > 0 ? innerRings : undefined,
      scalerank,
    }
  }

  return null
}

// ─── Coastline Conversion ─────────────────────────────────────────────────

function featureToCoastlines(feature: GeoJSONFeature, index: number): Coastline[] {
  const props = feature.properties
  const scalerank = (props.scalerank as number) ?? 10
  const geom = feature.geometry

  if (geom.type === 'LineString') {
    const coords = geom.coordinates as [number, number][]
    return [{
      id: `ne-coast-${index}`,
      points: coords.map(toLatLng),
      scalerank,
    }]
  }

  if (geom.type === 'MultiLineString') {
    const lines = geom.coordinates as [number, number][][]
    return lines.map((coords, li) => ({
      id: `ne-coast-${index}-${li}`,
      points: coords.map(toLatLng),
      scalerank,
    }))
  }

  return []
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Load and convert all Natural Earth rivers */
export async function loadNaturalEarthRivers(): Promise<River[]> {
  const fc = await loadGeoLayer('rivers')
  const rivers: River[] = []

  for (let i = 0; i < fc.features.length; i++) {
    const converted = featureToRivers(fc.features[i], i)
    rivers.push(...converted)
  }

  log.info('Rivers loaded', { features: fc.features.length, rivers: rivers.length })
  return rivers
}

/** Load and convert all Natural Earth lakes */
export async function loadNaturalEarthLakes(): Promise<WaterBody[]> {
  const fc = await loadGeoLayer('lakes')
  const lakes: WaterBody[] = []

  for (let i = 0; i < fc.features.length; i++) {
    const wb = featureToWaterBody(fc.features[i], i)
    if (wb) lakes.push(wb)
  }

  log.info('Lakes loaded', { features: fc.features.length, lakes: lakes.length })
  return lakes
}

/** Load and convert all Natural Earth glaciers */
export async function loadNaturalEarthGlaciers(): Promise<Glacier[]> {
  const fc = await loadGeoLayer('glaciers')
  const glaciers: Glacier[] = []

  for (let i = 0; i < fc.features.length; i++) {
    const g = featureToGlacier(fc.features[i], i)
    if (g) glaciers.push(g)
  }

  log.info('Glaciers loaded', { features: fc.features.length, glaciers: glaciers.length })
  return glaciers
}

/** Load and convert all Natural Earth coastlines */
export async function loadNaturalEarthCoastlines(): Promise<Coastline[]> {
  const fc = await loadGeoLayer('coastline')
  const coastlines: Coastline[] = []

  for (let i = 0; i < fc.features.length; i++) {
    const converted = featureToCoastlines(fc.features[i], i)
    coastlines.push(...converted)
  }

  log.info('Coastlines loaded', { features: fc.features.length, coastlines: coastlines.length })
  return coastlines
}

/** Load all four layers in parallel */
export async function loadAllNaturalEarthData(): Promise<{
  rivers: River[]
  lakes: WaterBody[]
  glaciers: Glacier[]
}> {
  const [rivers, lakes, glaciers] = await Promise.all([
    loadNaturalEarthRivers(),
    loadNaturalEarthLakes(),
    loadNaturalEarthGlaciers(),
  ])
  return { rivers, lakes, glaciers }
}
