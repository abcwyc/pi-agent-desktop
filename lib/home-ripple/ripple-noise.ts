/**
 * The value noise the glyph field's clouds, the ripple patches and the wave
 * speed field are drawn from: a lattice hash, bilinear smoothing and three
 * octaves summed. It is deterministic in its inputs, so a redraw of the same
 * frame reads the same clouds.
 */

/** A pseudo-random number in [0, 1) for one integer pair. */
export function hash(a: number, b: number) {
  let h = (a * 374761393 + b * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177 | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx
  const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx
  return top + (bottom - top) * sy
}

/** Three octaves of value noise; the result is spread around 0.5. */
export function fractalNoise(x: number, y: number) {
  return (valueNoise(x, y) * 4 + valueNoise(x * 2.1 + 7, y * 2.1 + 3) * 2 + valueNoise(x * 4.3 + 13, y * 4.3 + 11)) / 7
}
