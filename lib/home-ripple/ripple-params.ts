/**
 * The numbers the home page's glyph field and its ripples run on, tuned by
 * eye against Claude Code's new-conversation screen. Lengths are CSS pixels,
 * speeds pixels per second.
 */
export const RIPPLE = {
  /** The glyph grid: one cell per character, drawn in the skin's code face. */
  fontSize: 10,
  cellWidth: 7,
  cellHeight: 15,
  /** How often the whole field draws its characters again, per second. */
  changeRate: 2,
  /** Share of the characters that are digits; the rest are letters. */
  digitRatio: 0.3,
  /** The cloud that hides the field: block size, covered share, edge softness and drift speed. */
  cloudScale: 100,
  cloudCoverage: 1,
  cloudSoftness: 0.1,
  cloudDrift: 8,
  /** The field's idle opacity under the cloud, per theme. */
  idleAlphaLight: 0.26,
  idleAlphaDark: 0.24,
  /** The wave's speed at the click and far from it, and the distance over which one becomes the other. */
  speedNear: 1100,
  speedFar: 80,
  speedFalloff: 240,
  /** Damping per second, the width of the absorbing border in cells, and how far the speed varies across the page. */
  damping: 1,
  borderCells: 6,
  turbulence: 0.45,
  turbulenceScale: 180,
  /** The source's oscillation in Hz, its Gaussian radius and its amplitude; every click scales the last two at random. */
  sourceFrequency: 6,
  sourceRadius: 36,
  sourceAmplitude: 1.4,
  /** From wave height to how strongly a character is coloured. */
  waveGain: 3.5,
  /** A character stays shown after a wave passes: its fade-out time, its opacity, and the patchwork of how much of it shows. */
  glowDecay: 1.2,
  glowAlpha: 0.3,
  waveAlpha: 0.85,
  patchScale: 60,
  patchFloor: 0.3,
} as const

/** The wave equation's fixed integration step in seconds, independent of the frame rate. */
export const WAVE_STEP = 1 / 600
