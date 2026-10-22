/**
 * Axis arithmetic shared by the inline SVG charts — Explore's bar and line
 * charts and the finance reports' trend chart. Pure functions, so each can be
 * checked on its own: round tick steps through zero, compact tick labels,
 * category labels that thin out instead of colliding, and column shapes.
 */

export type Axis = {
  /** Bottom and top of the axis. Both are whole steps. */
  min: number;
  max: number;
  step: number;
  ticks: number[];
};

const MULTIPLIERS = [1, 2, 2.5, 5];

/**
 * A y-axis on round steps (1, 2, 2.5 or 5 × a power of ten) that always
 * includes zero, so bars grow from a labelled baseline and a dip below it is
 * plain. Of the steps that cut the axis into `intervals` (fewest, most), the
 * one leaving the least empty height wins; on a tie, the one with fewer
 * gridlines. When no step fits the range, the closest one does.
 *
 * `minSpan` keeps a flat or nearly flat series on an axis at least that tall,
 * away from zero; `integerSteps` keeps every step a whole number, for values
 * counted in cents.
 */
export function niceAxis(
  values: number[],
  {
    intervals = [3, 6],
    minSpan = 0,
    integerSteps = false,
  }: { intervals?: [number, number]; minSpan?: number; integerSteps?: boolean } = {},
): Axis {
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  const span = Math.max(minSpan, high === low ? 1 : 0);
  if (high - low < span) {
    if (high > 0 || low === 0) high = low + span;
    else low = high - span;
  }
  const [fewest, most] = intervals;
  const magnitude = 10 ** Math.floor(Math.log10((high - low) / most));
  let best: (Omit<Axis, "ticks"> & { miss: number }) | null = null;
  for (const scale of [magnitude / 10, magnitude, magnitude * 10, magnitude * 100]) {
    for (const multiplier of MULTIPLIERS) {
      const step = integerSteps
        ? Math.max(1, Math.round(multiplier * scale))
        : clean(multiplier * scale, multiplier * scale);
      const min = clean(Math.floor(low / step) * step, step);
      const max = clean(Math.ceil(high / step) * step, step);
      const count = Math.round((max - min) / step);
      const miss = count < fewest ? fewest - count : count > most ? count - most : 0;
      if (
        !best ||
        miss < best.miss ||
        (miss === best.miss && max - min < best.max - best.min) ||
        (miss === best.miss && max - min === best.max - best.min && step > best.step)
      ) {
        best = { min, max, step, miss };
      }
    }
  }
  const { min, max, step } = best!;
  const ticks: number[] = [];
  const count = Math.round((max - min) / step);
  // `|| 0` keeps a negative zero from printing as "-0".
  for (let i = 0; i <= count; i++) ticks.push(clean(min + i * step, step) || 0);
  return { min, max, step, ticks };
}

/** Round away floating-point dust (0.30000000000000004) to the step's precision. */
function clean(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.abs(step))) + 1);
  return Number(value.toFixed(Math.min(decimals, 20)));
}

/**
 * A tick label: "25K", "1.25M", "-500", or "0.25" when the step is a
 * fraction — as many decimals as the step needs and no trailing zeros.
 */
export function formatAxisNumber(value: number, step: number): string {
  if (Math.abs(step) < 1) {
    const decimals = Math.max(0, Math.ceil(-Math.log10(Math.abs(step))) + 1);
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.min(decimals, 20),
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Every how-many-th category the axis can name without two labels touching,
 * given each label's width and the distance between neighbouring categories.
 * Labels are taken from the first: 0, stride, 2 × stride…
 */
export function labelStride(widths: number[], spacing: number, gap = 10): number {
  for (let stride = 1; stride < widths.length; stride++) {
    let fits = true;
    for (let i = stride; i < widths.length && fits; i += stride) {
      fits = stride * spacing >= (widths[i - stride] + widths[i]) / 2 + gap;
    }
    if (fits) return stride;
  }
  return Math.max(1, widths.length);
}

/** `text`, shortened with an ellipsis until `measure` says it fits `maxWidth`. */
export function fitText(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, Math.max(1, low))}…`;
}

/** Centre a 1px line on a pixel row so it renders sharp instead of as a 2px blur. */
export function crisp(y: number): number {
  return Math.round(y) + 0.5;
}

/**
 * A column from `base` (the zero line, or the segment beneath) to `end`,
 * rounded only at the value's end — and square there too when `radius` is 0.
 */
export function columnPath(
  x: number,
  base: number,
  end: number,
  width: number,
  radius = 4,
): string {
  const r = Math.min(radius, width / 2, Math.abs(end - base));
  if (r <= 0) return `M${x},${base}V${end}H${x + width}V${base}Z`;
  if (end < base) {
    return `M${x},${base}V${end + r}A${r},${r} 0 0 1 ${x + r},${end}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${end + r}V${base}Z`;
  }
  return `M${x},${base}V${end - r}A${r},${r} 0 0 0 ${x + r},${end}H${x + width - r}A${r},${r} 0 0 0 ${x + width},${end - r}V${base}Z`;
}
