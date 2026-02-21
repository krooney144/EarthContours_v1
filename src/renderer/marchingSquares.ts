/**
 * EarthContours — Marching Squares
 *
 * Extracts iso-contour line segments from a height grid at a given threshold.
 * Shared by EXPLORE (orbit contour view) and SCAN (first-person contour overlay).
 *
 * Algorithm: for each 2×2 cell, classify the four corners as above/below the
 * threshold. One of 16 cases maps to edge crossings (where the iso-level
 * intersects the cell boundary). Linear interpolation pins the crossing point
 * precisely to sub-cell accuracy.
 *
 * Output is in "grid space" — x and y normalized to [0, 1] across the grid
 * dimensions. Callers convert to world / screen space as needed.
 */

// ─── Edge Table ───────────────────────────────────────────────────────────────

/**
 * For each of the 16 marching-squares cases, the list of edge pairs
 * [fromEdge, toEdge] that produce line segments.
 *
 * Edge numbering: 0=top, 1=right, 2=bottom, 3=left
 * Case bits: bit0=TL>t, bit1=TR>t, bit2=BR>t, bit3=BL>t
 */
const MS_EDGES: Array<Array<[number, number]>> = [
  [],              // 0000 — all below
  [[3, 0]],        // 0001 — TL above
  [[0, 1]],        // 0010 — TR above
  [[3, 1]],        // 0011 — TL+TR above
  [[1, 2]],        // 0100 — BR above
  [[3, 0],[1, 2]], // 0101 — TL+BR (saddle — consistent diagonal pick)
  [[0, 2]],        // 0110 — TR+BR above
  [[3, 2]],        // 0111 — TL+TR+BR above
  [[2, 3]],        // 1000 — BL above
  [[2, 0]],        // 1001 — TL+BL above
  [[0, 1],[2, 3]], // 1010 — TR+BL (saddle)
  [[2, 1]],        // 1011 — TL+TR+BL above
  [[1, 3]],        // 1100 — BR+BL above
  [[1, 0]],        // 1101 — TL+BR+BL above
  [[0, 3]],        // 1110 — TR+BR+BL above
  [],              // 1111 — all above
]

// ─── Segment Type ─────────────────────────────────────────────────────────────

/**
 * A contour line segment in normalized grid space.
 * Both endpoints are in [0, 1] × [0, 1] across the grid.
 */
export interface ContourSegment {
  x1: number; y1: number
  x2: number; y2: number
}

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * Extract all contour line segments at `threshold` from an elevation grid.
 *
 * @param elevations  Flat row-major Float32Array of elevation values
 * @param w           Grid width (number of columns)
 * @param h           Grid height (number of rows)
 * @param threshold   Elevation value to trace the contour along
 * @returns           Array of line segments in normalized [0,1] grid space
 */
export function marchingSquares(
  elevations: Float32Array,
  w: number,
  h: number,
  threshold: number,
): ContourSegment[] {
  const segments: ContourSegment[] = []

  for (let row = 0; row < h - 1; row++) {
    for (let col = 0; col < w - 1; col++) {
      const tl = elevations[row * w + col]
      const tr = elevations[row * w + col + 1]
      const br = elevations[(row + 1) * w + col + 1]
      const bl = elevations[(row + 1) * w + col]

      // Build case index from corner states
      const caseIdx =
        ((tl > threshold) ? 1 : 0) |
        ((tr > threshold) ? 2 : 0) |
        ((br > threshold) ? 4 : 0) |
        ((bl > threshold) ? 8 : 0)

      const edgePairs = MS_EDGES[caseIdx]
      if (edgePairs.length === 0) continue

      // Normalized cell corner positions in [0,1] grid space
      const x0 = col / (w - 1)
      const x1 = (col + 1) / (w - 1)
      const y0 = row / (h - 1)
      const y1 = (row + 1) / (h - 1)

      // Linear interpolation factors for each edge crossing
      const tTop    = tl !== tr ? (threshold - tl) / (tr - tl) : 0.5
      const tRight  = tr !== br ? (threshold - tr) / (br - tr) : 0.5
      const tBottom = bl !== br ? (threshold - bl) / (br - bl) : 0.5
      const tLeft   = tl !== bl ? (threshold - tl) / (bl - tl) : 0.5

      // Crossing point per edge — edge 0=top, 1=right, 2=bottom, 3=left
      const edgePts: Array<[number, number]> = [
        [x0 + tTop    * (x1 - x0), y0],          // top
        [x1,                       y0 + tRight * (y1 - y0)],  // right
        [x0 + tBottom * (x1 - x0), y1],          // bottom
        [x0,                       y0 + tLeft  * (y1 - y0)],  // left
      ]

      for (const [fromEdge, toEdge] of edgePairs) {
        const [px1, py1] = edgePts[fromEdge]
        const [px2, py2] = edgePts[toEdge]
        segments.push({ x1: px1, y1: py1, x2: px2, y2: py2 })
      }
    }
  }

  return segments
}
