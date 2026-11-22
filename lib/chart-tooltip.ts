/**
 * What a ```chart hover tooltip says (components/ChartBlock.tsx).
 *
 * diagrammatic's interactive layer reports only an address for the mark under
 * the pointer: `i` (index), `i2`, `series` (the data-* stamps on each mark).
 * The values come from our own cleaned spec, so the tooltip shows exactly
 * what the model wrote, unrounded: the axes print "12k", the tooltip
 * "12,000". Stamps per form, checked against the library's output:
 * bar / column / pie / funnel / waterfall / scatter: `i` is the item;
 * line / area: points carry `i` (and `series` with several lines);
 * stacked / grouped bars: segments carry `i` + `series`, a pad per group
 * carries `i` alone; heatmap: `i` is the column, `i2` the row.
 */
import type { CleanChartSpec } from "./chart-spec";

export interface ChartMarkAddress {
  index?: number;
  index2?: number;
  series?: string;
}

export interface ChartTooltipRow {
  label: string;
  value: string;
  /** The series this row belongs to, for its colour swatch. */
  series?: string;
  /** The hovered series among several rows. */
  active?: boolean;
}

export interface ChartTooltipContent {
  title: string;
  rows: ChartTooltipRow[];
}

// Built at run time: literal or escaped, the character was rewritten on disk here.
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), "g");
const clean = (text: unknown): string => String(text ?? "").replace(ZERO_WIDTH, "");

/** A value as the model wrote it, grouped by locale; percent keeps the sign the axis uses. */
export function formatTooltipValue(value: number, unit: unknown, locale?: string): string {
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  return unit === "percent" ? `${text}%` : text;
}

type Item = { label: string; value: number };
type Series = { name: string; data: number[] };

const at = <T,>(list: unknown, index: number | undefined): T | undefined =>
  Array.isArray(list) && index !== undefined && index >= 0 && index < list.length ? (list[index] as T) : undefined;

/** The tooltip for a mark, or null when the address does not name a value (a whole line, a frame). */
export function describeChartMark(spec: CleanChartSpec, mark: ChartMarkAddress, locale?: string): ChartTooltipContent | null {
  const format = (value: number) => formatTooltipValue(value, spec.unit, locale);
  const { index, index2, series } = mark;
  switch (spec.type) {
    case "bar":
    case "column":
    case "pie":
    case "funnel": {
      const item = at<Item>(spec.items, index);
      if (!item) return null;
      const rows: ChartTooltipRow[] = [{ label: clean(item.label), value: format(item.value) }];
      if (spec.type === "pie" && Array.isArray(spec.items)) {
        const total = (spec.items as Item[]).reduce((sum, entry) => sum + entry.value, 0);
        if (total > 0) rows[0].value += ` · ${new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(item.value / total)}`;
      }
      return { title: clean(item.label), rows: rows.map((row) => ({ ...row, label: "" })) };
    }
    case "waterfall": {
      const step = at<{ label: string; value: number; total?: boolean }>(spec.steps, index);
      if (!step) return null;
      return { title: clean(step.label), rows: [{ label: "", value: format(step.value) }] };
    }
    case "line":
    case "area": {
      if (index === undefined) return null;
      const title = clean(at<string>(spec.labels, index) ?? `#${index + 1}`);
      if (Array.isArray(spec.series)) {
        const rows = (spec.series as Series[]).flatMap((entry) => {
          const value = at<number>(entry.data, index);
          return value === undefined ? [] : [{ label: clean(entry.name), value: format(value), series: entry.name, active: series !== undefined && clean(series) === clean(entry.name) }];
        });
        return rows.length ? { title, rows } : null;
      }
      const value = at<number>(spec.data, index);
      return value === undefined ? null : { title, rows: [{ label: "", value: format(value) }] };
    }
    case "stacked-bar":
    case "grouped-bar": {
      const group = at<string>(spec.groups, index);
      if (group === undefined || !Array.isArray(spec.series)) return null;
      const all = spec.series as Series[];
      const rows: ChartTooltipRow[] = all.flatMap((entry) => {
        const value = at<number>(entry.data, index);
        return value === undefined ? [] : [{ label: clean(entry.name), value: format(value), series: entry.name, active: series !== undefined && clean(series) === clean(entry.name) }];
      });
      if (spec.type === "stacked-bar" && rows.length > 1) {
        const total = all.reduce((sum, entry) => sum + (at<number>(entry.data, index) ?? 0), 0);
        rows.push({ label: "Σ", value: format(total) });
      }
      return rows.length ? { title: clean(group), rows } : null;
    }
    case "scatter": {
      const point = at<{ x: number; y: number; label?: string; series?: string }>(spec.points, index);
      if (!point) return null;
      const title = clean(point.label ?? point.series ?? `#${(index ?? 0) + 1}`);
      return { title, rows: [{ label: "x", value: format(point.x) }, { label: "y", value: format(point.y) }] };
    }
    case "heatmap": {
      const matrix = spec.matrix as { rows: string[]; cols: string[]; values: number[][] } | undefined;
      const value = at<number>(at<number[]>(matrix?.values, index2), index);
      if (!matrix || value === undefined) return null;
      return { title: `${clean(at<string>(matrix.rows, index2))} · ${clean(at<string>(matrix.cols, index))}`, rows: [{ label: "", value: format(value) }] };
    }
    default:
      return null;
  }
}
