/** Adapted from Nwflower/dsh-claude-style, copyright 2026 Nwflower (MIT).
 * Host colour resolution removed; Pi supplies resolved RGB channels directly.
 * See public/claude-companion/NOTICE.txt for the original license. */
import { fractalNoise, hash } from './ripple-noise'
import { RIPPLE } from './ripple-params'
import type { WaveField } from './ripple-wave'

/** An opaque colour as three 0–255 channels. */
export type Rgb = readonly [number, number, number]

/** What one frame is drawn with: the theme's two inks and the face the grid is set in. */
export interface FieldPalette {
  ink: Rgb
  wave: Rgb
  dark: boolean
  fontFamily: string
}

/** The glyph field on one canvas: it draws the grid, keeps what the waves left showing, and says whether it needs the next frame. */
export interface GlyphField {
  /** Draw the grid for the time `now` (ms) and the waves' present heights. */
  draw(now: number, palette: FieldPalette, still: boolean): void
  /** Whether a frame at `now` would differ from the last one drawn. */
  needsDraw(now: number, still: boolean): boolean
  /** Whether the waves or what they left showing are still changing, so the next frame cannot be skipped. */
  busy(): boolean
  /** Ask for a draw at the next opportunity. */
  invalidate(): void
  /** Give back the GPU resources; the canvas is free for a new field. */
  dispose(): void
}

/**
 * The channels of a theme token's colour, or null for a value the field cannot
 * paint with: the page states a token as a literal, the host's alias, or the
 * relative colour a reader's palette derives from their canvas (D30), and the
 * field sets solid glyphs with no backdrop of its own to mix a translucent ink
 * into.
 */

const DIGITS = '0123456789'
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** Every character the field can show, in the order of the glyph atlas. */
const GLYPHS = DIGITS + LETTERS
/** The noise is spread around 0.5; this turns the covered share into the threshold the cloud's edge sits at. */
const COVERAGE_TO_THRESHOLD = 0.39
/** A cell dimmer than this draws nothing. */
const INVISIBLE_ALPHA = 0.01

/** The index of the character a cell shows during one tick. */
function glyphIndex(column: number, row: number, tick: number) {
  const digit = hash(column * 7 + tick * 13, row * 11 + tick * 3) < RIPPLE.digitRatio
  const pick = hash(column * 131 + tick, row * 197 + tick * 7)
  return digit ? Math.floor(pick * DIGITS.length) : DIGITS.length + Math.floor(pick * LETTERS.length)
}

function smooth(value: number) {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}

/** How much of the field the cloud lets show at one point, from 0 (hidden) to 1 (clear). */
function cloudClear(x: number, y: number) {
  const noise = fractalNoise(x / RIPPLE.cloudScale, y / RIPPLE.cloudScale)
  const threshold = 0.5 + (RIPPLE.cloudCoverage - 0.5) * COVERAGE_TO_THRESHOLD
  return smooth((noise - threshold + RIPPLE.cloudSoftness) / (2 * RIPPLE.cloudSoftness))
}

/** The patchwork that breaks a ring into pieces: how much of what the waves reveal shows at one point. */
function patchClear(x: number, y: number) {
  const noise = fractalNoise(x / RIPPLE.patchScale + 31, y / RIPPLE.patchScale + 17)
  return RIPPLE.patchFloor + (1 - RIPPLE.patchFloor) * smooth((noise - 0.35) / 0.3)
}

// One triangle covers the canvas; the fragment shader finds its cell, reads the
// cell's character, opacity and colour mix from the data texture, and the
// character's coverage from the atlas.
const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform sampler2D atlas;
uniform vec2 size;
uniform vec2 grid;
uniform vec2 cellPixels;
uniform vec2 atlasCell;
uniform float glyphCount;
uniform vec3 ink;
uniform vec3 wave;
out vec4 color;
void main() {
  vec2 position = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 cell = min(floor(position / cellPixels), grid - 1.0);
  vec2 local = position - cell * cellPixels;
  vec4 data = texelFetch(cells, ivec2(cell), 0);
  float glyph = floor(data.r * 255.0 + 0.5);
  vec2 inAtlas = vec2(glyph * atlasCell.x + local.x * atlasCell.x / cellPixels.x, local.y * atlasCell.y / cellPixels.y);
  float coverage = texture(atlas, inAtlas / vec2(glyphCount * atlasCell.x, atlasCell.y)).a;
  float alpha = data.g * coverage;
  color = vec4(mix(ink, wave, data.b) * alpha, alpha);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (shader === null) throw new Error('home-ripple: the shader could not be created')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`home-ripple: shader failed to compile: ${gl.getShaderInfoLog(shader) ?? ''}`)
  return shader
}

/** The GPU side of one field: its program, the per-cell data texture and the glyph atlas. */
function createRenderer(canvas: HTMLCanvasElement, columns: number, rows: number) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
  if (gl === null) throw new Error('home-ripple: the canvas has no webgl2 context')
  const atlasCanvas = canvas.ownerDocument.createElement('canvas')
  const atlasContext = atlasCanvas.getContext('2d')
  if (atlasContext === null) throw new Error('home-ripple: the atlas canvas has no 2d context')
  const data = new Uint8Array(columns * rows * 4)
  let program: WebGLProgram
  let cellTexture: WebGLTexture
  let atlasTexture: WebGLTexture
  let uniforms: Record<string, WebGLUniformLocation | null>
  let atlasKey = ''

  function createTexture(unit: number, filter: number) {
    const texture = gl!.createTexture()
    if (texture === null) throw new Error('home-ripple: the texture could not be created')
    gl!.activeTexture(gl!.TEXTURE0 + unit)
    gl!.bindTexture(gl!.TEXTURE_2D, texture)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    return texture
  }

  /** Build every GPU object; it runs again when the browser restores a lost context. */
  function build() {
    const created = gl!.createProgram()
    if (created === null) throw new Error('home-ripple: the program could not be created')
    program = created
    gl!.attachShader(program, compile(gl!, gl!.VERTEX_SHADER, VERTEX_SHADER))
    gl!.attachShader(program, compile(gl!, gl!.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl!.linkProgram(program)
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) throw new Error(`home-ripple: program failed to link: ${gl!.getProgramInfoLog(program) ?? ''}`)
    gl!.useProgram(program)
    uniforms = {}
    for (const name of ['cells', 'atlas', 'size', 'grid', 'cellPixels', 'atlasCell', 'glyphCount', 'ink', 'wave']) uniforms[name] = gl!.getUniformLocation(program, name)
    cellTexture = createTexture(0, gl!.NEAREST)
    atlasTexture = createTexture(1, gl!.LINEAR)
    gl!.uniform1i(uniforms.cells!, 0)
    gl!.uniform1i(uniforms.atlas!, 1)
    atlasKey = ''
  }

  /** The characters set once, white on clear, one cell each, at the canvas's pixel density. */
  function buildAtlas(font: string, dpr: number) {
    const key = `${font}|${dpr}`
    if (key === atlasKey) return
    const width = Math.ceil(RIPPLE.cellWidth * dpr)
    const height = Math.ceil(RIPPLE.cellHeight * dpr)
    atlasCanvas.width = width * GLYPHS.length
    atlasCanvas.height = height
    atlasContext!.setTransform(width / RIPPLE.cellWidth, 0, 0, height / RIPPLE.cellHeight, 0, 0)
    atlasContext!.clearRect(0, 0, RIPPLE.cellWidth * GLYPHS.length, RIPPLE.cellHeight)
    atlasContext!.font = `${RIPPLE.fontSize}px ${font}`
    atlasContext!.textBaseline = 'middle'
    atlasContext!.textAlign = 'center'
    atlasContext!.fillStyle = '#fff'
    for (let index = 0; index < GLYPHS.length; index++) atlasContext!.fillText(GLYPHS[index]!, index * RIPPLE.cellWidth + RIPPLE.cellWidth / 2, RIPPLE.cellHeight / 2)
    gl!.activeTexture(gl!.TEXTURE1)
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTexture)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, atlasCanvas)
    gl!.uniform2f(uniforms.atlasCell!, width, height)
    gl!.uniform1f(uniforms.glyphCount!, GLYPHS.length)
    atlasKey = key
  }

  build()
  return {
    data,
    build,
    draw(palette: FieldPalette, dpr: number) {
      buildAtlas(palette.fontFamily, dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(uniforms.size!, canvas.width, canvas.height)
      gl.uniform2f(uniforms.grid!, columns, rows)
      gl.uniform2f(uniforms.cellPixels!, RIPPLE.cellWidth * dpr, RIPPLE.cellHeight * dpr)
      gl.uniform3f(uniforms.ink!, palette.ink[0] / 255, palette.ink[1] / 255, palette.ink[2] / 255)
      gl.uniform3f(uniforms.wave!, palette.wave[0] / 255, palette.wave[1] / 255, palette.wave[2] / 255)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, cellTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteProgram(program)
      gl.deleteTexture(cellTexture)
      gl.deleteTexture(atlasTexture)
    },
  }
}

/**
 * The field's characters, drawn on the GPU in one pass. The characters change
 * at a fixed rate and never move; the cloud over them drifts a whole cell at a
 * time, and a wave lets the characters it passes show — blue at its front, grey
 * in its wake, fading as the glow decays.
 *
 * The CPU keeps one small table of a character, an opacity and a colour mix
 * per cell and uploads it each draw; the characters themselves come from an
 * atlas set once, so a frame costs one texture upload and one draw call. The
 * cloud's columns are computed once each as the drift reaches them, and the
 * patchwork once per grid size.
 */
export function createGlyphField(canvas: HTMLCanvasElement, columns: number, rows: number, waves: WaveField): GlyphField {
  const renderer = createRenderer(canvas, columns, rows)
  const { cellWidth, cellHeight } = RIPPLE
  const cells = columns * rows
  /** How much of each cell a passing wave left showing, fading by the glow decay. */
  const glow = new Float32Array(cells)
  const patch = new Float32Array(cells)
  const glyphs = new Uint8Array(cells)
  /** The cloud's columns by absolute column index, so a drift of one cell computes one new column. */
  const cloudColumns = new Map<number, Float32Array>()
  let lastTick = -1
  let lastDraw = 0
  let glowing = false
  let stale = true

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      patch[row * columns + column] = patchClear(column * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2)
    }
  }

  // The browser may take the context away; it gives it back on request, and the field draws again from scratch.
  function onContextLost(event: Event) { event.preventDefault() }
  function onContextRestored() {
    renderer.build()
    stale = true
  }
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  function tickAt(now: number, still: boolean) {
    return still ? 0 : Math.floor(now / 1000 * RIPPLE.changeRate)
  }

  function cloudColumn(absolute: number) {
    let column = cloudColumns.get(absolute)
    if (column === undefined) {
      column = new Float32Array(rows)
      for (let row = 0; row < rows; row++) column[row] = cloudClear(absolute * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2)
      cloudColumns.set(absolute, column)
    }
    return column
  }

  return {
    invalidate() { stale = true },
    busy: () => waves.active() || glowing,
    needsDraw(now, still) {
      return stale || waves.active() || glowing || tickAt(now, still) !== lastTick
    },
    draw(now, palette, still) {
      const tick = tickAt(now, still)
      if (tick !== lastTick) {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) glyphs[row * columns + column] = glyphIndex(column, row, tick)
        }
      }
      const drift = Math.floor((still ? 0 : now / 1000) * RIPPLE.cloudDrift / cellWidth)
      for (const absolute of cloudColumns.keys()) if (absolute < drift) cloudColumns.delete(absolute)
      const decay = Math.exp(-Math.min((now - lastDraw) / 1000, 0.1) / RIPPLE.glowDecay)
      const idleAlpha = palette.dark ? RIPPLE.idleAlphaDark : RIPPLE.idleAlphaLight
      const { data } = renderer

      let brightest = 0
      for (let column = 0; column < columns; column++) {
        const clouds = cloudColumn(column + drift)
        for (let row = 0; row < rows; row++) {
          const cell = row * columns + column
          const strength = Math.tanh(RIPPLE.waveGain * Math.abs(waves.height[cell]!))
          const shown = Math.max(glow[cell]! * decay, strength)
          const lit = shown < 0.01 ? 0 : shown
          glow[cell] = lit
          let alpha = idleAlpha * clouds[row]!
          if (lit > 0) {
            brightest = Math.max(brightest, lit)
            alpha = Math.min(1, alpha + patch[cell]! * (lit * RIPPLE.glowAlpha + strength * RIPPLE.waveAlpha))
          }
          const at = cell * 4
          data[at] = glyphs[cell]!
          data[at + 1] = alpha < INVISIBLE_ALPHA ? 0 : Math.round(alpha * 255)
          data[at + 2] = lit > 0 ? Math.round(strength * 255) : 0
        }
      }
      renderer.draw(palette, canvas.width / (columns * cellWidth))
      glowing = brightest > 0
      lastTick = tick
      lastDraw = now
      stale = false
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      renderer.dispose()
    },
  }
}
