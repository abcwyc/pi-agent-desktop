import { fractalNoise } from './ripple-noise'
import { RIPPLE, WAVE_STEP } from './ripple-params'

/** The waves on the glyph grid: a height per cell, advanced by the damped wave equation. */
export interface WaveField {
  /** The height of every cell, row by row. */
  readonly height: Float32Array
  /** Whether any wave is still moving. */
  active(): boolean
  /** Start a click's waves at one cell. */
  disturb(column: number, row: number): void
  /** Run the waves forward by `seconds`, in fixed steps. */
  advance(seconds: number): void
}

/** One click's source: a Gaussian patch driven for one or two periods of a sine. */
interface Source {
  column: number
  row: number
  time: number
  duration: number
  radiusScale: number
  amplitudeScale: number
}

/** A frame that arrives late runs at most this long, so a hidden page does not replay the time it missed. */
const MAX_ADVANCE = 0.05
/** Below this the whole field counts as still. */
const REST_HEIGHT = 0.003

/**
 * The waves are the solution of ∂²h/∂t² = c²∇²h − γ∂h/∂t, integrated by the
 * symplectic Euler step. The Laplacian divides by the cell's width and height
 * squared, so the rings stay round on a grid whose cells are not square. Every
 * click raises the speed around itself, fastest at its cell and falling with the
 * distance from it, and a cell keeps the fastest of the clicks that are still
 * rippling: a ring slows along the curve of the click that started it, and a
 * click elsewhere in the field leaves that curve alone. The border cells damp
 * strongly and swallow what reaches them. A step is stable while
 * c·step·√(4/dx² + 4/dy²) < 2, which the largest speed (1.4 × speedNear, from
 * the noise factor's cap) satisfies at WAVE_STEP.
 *
 * @param columns - the grid's width in cells.
 * @param rows - the grid's height in cells.
 * @param random - the source of the field's noise seed and each click's shape;
 *   tests pass a seeded sequence so one sampled profile cannot decide a check.
 */
export function createWaveField(columns: number, rows: number, random: () => number = Math.random): WaveField {
  const cells = columns * rows
  const height = new Float32Array(cells)
  const velocity = new Float32Array(cells)
  const speedSquared = new Float32Array(cells)
  const speedFactor = new Float32Array(cells)
  const damping = new Float32Array(cells)
  const seed = random() * 1000
  const { cellWidth, cellHeight } = RIPPLE
  const widthSquared = cellWidth * cellWidth
  const heightSquared = cellHeight * cellHeight
  let sources: Source[] = []
  let moving = false
  let behind = 0

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const cell = row * columns + column
      const noise = fractalNoise(column * cellWidth / RIPPLE.turbulenceScale + seed, row * cellHeight / RIPPLE.turbulenceScale + seed)
      speedFactor[cell] = Math.min(1.4, Math.max(0.3, 1 + RIPPLE.turbulence * (noise - 0.5) * 3.2))
      const edge = Math.min(column, row, columns - 1 - column, rows - 1 - row)
      const border = Math.max(0, 1 - edge / RIPPLE.borderCells) ** 2
      damping[cell] = RIPPLE.damping + border * 12
    }
  }

  /**
   * Raise the speed around one click to its own profile: fast at its cell,
   * `speedFar` far away. A cell never loses a speed a click gave it until the
   * field comes to rest, so a ring keeps the curve of the click it came from
   * while later clicks only speed up the ground around themselves.
   */
  function raiseSpeeds(column: number, row: number) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = r * columns + c
        const distance = Math.hypot((c - column) * cellWidth, (r - row) * cellHeight)
        const speed = (RIPPLE.speedFar + (RIPPLE.speedNear - RIPPLE.speedFar) * Math.exp(-distance / RIPPLE.speedFalloff)) * speedFactor[cell]!
        const squared = speed * speed
        if (squared > speedSquared[cell]!) speedSquared[cell] = squared
      }
    }
  }

  function drive() {
    for (const source of sources) {
      const envelope = Math.sin(Math.PI * source.time / source.duration)
      const rate = Math.cos(2 * Math.PI * RIPPLE.sourceFrequency * source.time) * 2 * Math.PI * RIPPLE.sourceFrequency
      const radius = RIPPLE.sourceRadius * source.radiusScale
      const reachColumns = Math.ceil(radius * 3 / cellWidth)
      const reachRows = Math.ceil(radius * 3 / cellHeight)
      for (let r = Math.max(0, source.row - reachRows); r <= Math.min(rows - 1, source.row + reachRows); r++) {
        for (let c = Math.max(0, source.column - reachColumns); c <= Math.min(columns - 1, source.column + reachColumns); c++) {
          const dx = (c - source.column) * cellWidth
          const dy = (r - source.row) * cellHeight
          const gauss = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius))
          height[r * columns + c]! += RIPPLE.sourceAmplitude * source.amplitudeScale * envelope * rate * gauss * WAVE_STEP
        }
      }
      source.time += WAVE_STEP
    }
    sources = sources.filter(source => source.time < source.duration)
  }

  function step() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = r * columns + c
        const here = height[cell]!
        const left = height[c > 0 ? cell - 1 : cell]!
        const right = height[c < columns - 1 ? cell + 1 : cell]!
        const above = height[r > 0 ? cell - columns : cell]!
        const below = height[r < rows - 1 ? cell + columns : cell]!
        const laplacian = (left + right - 2 * here) / widthSquared + (above + below - 2 * here) / heightSquared
        velocity[cell]! += (speedSquared[cell]! * laplacian - damping[cell]! * velocity[cell]!) * WAVE_STEP
      }
    }
    let peak = 0
    for (let cell = 0; cell < cells; cell++) {
      height[cell]! += velocity[cell]! * WAVE_STEP
      peak = Math.max(peak, Math.abs(height[cell]!))
    }
    drive()
    moving = sources.length > 0 || peak > REST_HEIGHT
    if (!moving) {
      // The field is still again, so the clicks that raised its speeds are gone with the waves they started.
      height.fill(0)
      velocity.fill(0)
      speedSquared.fill(0)
    }
  }

  return {
    height,
    active: () => moving,
    disturb(column, row) {
      raiseSpeeds(column, row)
      sources.push({
        column,
        row,
        time: 0,
        duration: (1 + Math.floor(random() * 2)) / RIPPLE.sourceFrequency,
        radiusScale: 0.7 + random() * 1.1,
        amplitudeScale: 0.6 + random() * 0.8,
      })
      moving = true
    },
    advance(seconds) {
      behind += Math.min(seconds, MAX_ADVANCE)
      while (behind >= WAVE_STEP) {
        step()
        behind -= WAVE_STEP
      }
    },
  }
}
