/**
 * ```chart fences: a JSON chart spec a model writes, checked here before
 * `diagrammatic` draws it (components/ChartBlock.tsx).
 *
 * The spec is rebuilt from an allowlist, never passed through: diagrammatic
 * forwards unknown top-level keys to the root <svg>, so a `style` with
 * `url(...)` would load a remote image from the user's machine, and `href`,
 * `on*` or `dangerouslySetInnerHTML` would reach React as props. Only the
 * fields below survive, each with its type checked; numbers must be finite,
 * because diagrammatic's own validateSpec only checks that fields exist and
 * a string where a number belongs throws deep inside a chart.
 */

export const CHART_FENCE_LANGS = new Set(["chart"]);

export const CHART_TYPES = [
  "bar", "column", "line", "area", "stacked-bar", "grouped-bar", "pie", "scatter", "heatmap", "waterfall", "funnel",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** The spec diagrammatic receives: plain JSON, only known keys. */
export type CleanChartSpec = { type: ChartType; title?: string } & Record<string, unknown>;

export type ChartSpecResult =
  | { ok: true; spec: CleanChartSpec; title: string | null; axes: { x: string | null; y: string | null } }
  | { ok: false; error: string };

const MAX_LABEL = 120;
const MAX_ITEMS = 500;
const MAX_POINTS = 5000;
const MAX_SERIES = 12;

class SpecError extends Error {}

const fail = (path: string, message: string): never => {
  throw new SpecError(`${path}: ${message}`);
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Full-width characters: CJK, kana, Hangul, full-width forms, emoji.
// Built from code points, never written as characters or \\u escapes: a
// bundle served without a charset reads literal CJK as Latin-1 bytes and the
// class throws "Range out of order" when the module loads (PR #256 e2e), and
// an editor here rewrote printable escapes back into characters.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK radicals through Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // full-width forms
  [0xffe0, 0xffe6], // full-width signs
  [0x1f300, 0x1faff], // emoji
];
const WIDE_RE = new RegExp(`[${WIDE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`, "gu");

/**
 * diagrammatic sizes label gutters and truncation as characters × 0.6 em,
 * which fits Latin text but not a CJK glyph (about 1 em): a Chinese category
 * name on a bar chart ran off the left edge. Each wide character is followed
 * by a zero-width space, so it counts as 1.2 em, a little more than it draws.
 * The space goes right after its character, not at the end of the label:
 * when a narrow chart cuts a label from the end, the padding must go with
 * the characters it stands for (padding at the end was cut first, and a
 * shortened Chinese label overflowed again on a phone).
 */
export function padWideText(text: string): string {
  return text.replace(WIDE_RE, "$&\u200b");
}

function text(value: unknown, path: string, required: true): string;
function text(value: unknown, path: string, required?: false): string | undefined;
function text(value: unknown, path: string, required = false): string | undefined {
  if (value === undefined || value === null) return required ? fail(path, "is required (a string)") : undefined;
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return fail(path, "must be a string");
  return padWideText(value.slice(0, MAX_LABEL));
}

function num(value: unknown, path: string, required: true): number;
function num(value: unknown, path: string, required?: false): number | undefined;
function num(value: unknown, path: string, required = false): number | undefined {
  if (value === undefined || value === null) return required ? fail(path, "is required (a number)") : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, `must be a finite number, got ${JSON.stringify(value)?.slice(0, 40)}`);
  return value;
}

function bool(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") return fail(path, "must be true or false");
  return value;
}

function list(value: unknown, path: string, max: number, required = true): unknown[] | undefined {
  if (value === undefined || value === null) return required ? fail(path, "is required (an array)") : undefined;
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (required && value.length === 0) return fail(path, "must not be empty");
  if (value.length > max) return fail(path, `has ${value.length} entries; at most ${max} are drawn`);
  return value;
}

const texts = (value: unknown, path: string, max = MAX_ITEMS, required = true): string[] | undefined =>
  list(value, path, max, required)?.map((entry, i) => text(entry, `${path}[${i}]`, true));

const numbers = (value: unknown, path: string, max = MAX_POINTS): number[] =>
  list(value, path, max)!.map((entry, i) => num(entry, `${path}[${i}]`, true));

function items(value: unknown, path: string): { label: string; value: number }[] {
  return list(value, path, MAX_ITEMS)!.map((entry, i) => {
    if (!isObject(entry)) return fail(`${path}[${i}]`, 'must be an object like {"label": "A", "value": 3}');
    return { label: text(entry.label, `${path}[${i}].label`, true), value: num(entry.value, `${path}[${i}].value`, true) };
  });
}

function series(value: unknown, path: string, length?: number): { name: string; data: number[] }[] {
  return list(value, path, MAX_SERIES)!.map((entry, i) => {
    if (!isObject(entry)) return fail(`${path}[${i}]`, 'must be an object like {"name": "A", "data": [1, 2]}');
    const data = numbers(entry.data, `${path}[${i}].data`);
    if (length !== undefined && data.length !== length) fail(`${path}[${i}].data`, `has ${data.length} values but there are ${length} labels`);
    return { name: text(entry.name, `${path}[${i}].name`, true), data };
  });
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !options.includes(value as T)) return fail(path, `must be one of ${options.join(", ")}`);
  return value as T;
}

/** line / area: one `data` array or several `series`, over optional x `labels`. */
function lineFields(spec: Record<string, unknown>): Record<string, unknown> {
  const labels = texts(spec.labels, "labels", MAX_POINTS, false);
  const out: Record<string, unknown> = { labels, yMax: num(spec.yMax, "yMax"), yTicks: 5 };
  if (spec.series !== undefined) out.series = series(spec.series, "series", labels?.length);
  else if (spec.data !== undefined) {
    out.data = numbers(spec.data, "data");
    if (labels && (out.data as number[]).length !== labels.length) fail("data", `has ${(out.data as number[]).length} values but there are ${labels.length} labels`);
  } else fail("series", 'is required (or "data" for a single line)');
  return out;
}

function groupedFields(spec: Record<string, unknown>): Record<string, unknown> {
  const groups = texts(spec.groups, "groups")!;
  return { groups, series: series(spec.series, "series", groups.length), yTicks: 5 };
}

const BUILDERS: Record<ChartType, (spec: Record<string, unknown>) => Record<string, unknown>> = {
  bar: (spec) => ({ items: items(spec.items, "items"), highlight: text(spec.highlight, "highlight") }),
  column: (spec) => ({ items: items(spec.items, "items"), highlight: text(spec.highlight, "highlight"), yTicks: 5 }),
  line: (spec) => ({ ...lineFields(spec), step: bool(spec.step, "step") }),
  area: lineFields,
  "stacked-bar": (spec) => ({ ...groupedFields(spec), normalize: bool(spec.normalize, "normalize") }),
  "grouped-bar": groupedFields,
  pie: (spec) => {
    const inner = num(spec.inner, "inner");
    if (inner !== undefined && (inner < 0 || inner > 0.9)) fail("inner", "must be between 0 and 0.9");
    return { items: items(spec.items, "items"), inner, centerLabel: text(spec.centerLabel, "centerLabel") };
  },
  scatter: (spec) => ({
    points: list(spec.points, "points", MAX_POINTS)!.map((entry, i) => {
      if (!isObject(entry)) return fail(`points[${i}]`, 'must be an object like {"x": 1, "y": 2}');
      return {
        x: num(entry.x, `points[${i}].x`, true),
        y: num(entry.y, `points[${i}].y`, true),
        size: num(entry.size, `points[${i}].size`),
        label: text(entry.label, `points[${i}].label`),
        series: text(entry.series, `points[${i}].series`),
      };
    }),
    trend: bool(spec.trend, "trend"),
    // xLabel / yLabel are checked here but drawn by ChartBlock (see `axes`).
    xTicks: 5,
    yTicks: 5,
  }),
  heatmap: (spec) => {
    if (!isObject(spec.matrix)) return fail("matrix", 'is required: {"rows": [...], "cols": [...], "values": [[...], ...]}');
    const rows = texts(spec.matrix.rows, "matrix.rows")!;
    const cols = texts(spec.matrix.cols, "matrix.cols")!;
    const values = list(spec.matrix.values, "matrix.values", MAX_ITEMS)!.map((row, r) => {
      const cells = numbers(row, `matrix.values[${r}]`);
      if (cells.length !== cols.length) fail(`matrix.values[${r}]`, `has ${cells.length} values but there are ${cols.length} cols`);
      return cells;
    });
    if (values.length !== rows.length) fail("matrix.values", `has ${values.length} rows but there are ${rows.length} row labels`);
    return { matrix: { rows, cols, values }, values: bool(spec.values, "values") };
  },
  waterfall: (spec) => ({
    steps: list(spec.steps, "steps", MAX_ITEMS)!.map((entry, i) => {
      if (!isObject(entry)) return fail(`steps[${i}]`, 'must be an object like {"label": "Start", "value": 10}');
      return { label: text(entry.label, `steps[${i}].label`, true), value: num(entry.value, `steps[${i}].value`, true), total: bool(entry.total, `steps[${i}].total`) };
    }),
    yTicks: 5,
  }),
  funnel: (spec) => ({ items: items(spec.items, "items"), rates: bool(spec.rates, "rates") }),
};

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** Parses and checks a ```chart fence. Errors name the field, so "Ask to fix" can send them as they are. */
export function parseChartSpec(source: string): ChartSpecResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    if (!isObject(raw)) return fail("spec", "must be a JSON object");
    const type = raw.type;
    if (typeof type !== "string" || !(CHART_TYPES as readonly string[]).includes(type)) {
      return fail("type", `must be one of ${CHART_TYPES.join(", ")}`);
    }
    const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : null;
    // diagrammatic centres an axis title on the tick row, where it covers the
    // middle tick (Latin labels too), so ChartBlock prints them under the title.
    const axisText = (key: "xLabel" | "yLabel") => (text(raw[key], key) ?? "").replace(/\u200b/g, "") || null;
    const axes = { x: axisText("xLabel"), y: axisText("yLabel") };
    const spec = dropUndefined({
      type,
      // diagrammatic uses the title only as the chart's accessible name; ChartBlock draws it.
      title: title ?? undefined,
      summary: typeof raw.summary === "string" ? raw.summary.slice(0, 500) : undefined,
      unit: oneOf(raw.unit, "unit", ["percent", "compact", "none"] as const),
      legend: bool(raw.legend, "legend"),
      ...BUILDERS[type as ChartType](raw),
    }) as CleanChartSpec;
    return { ok: true, spec, title, axes };
  } catch (error) {
    if (error instanceof SpecError) return { ok: false, error: error.message };
    throw error;
  }
}
