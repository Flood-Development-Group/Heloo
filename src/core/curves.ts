import type { CurvePoint } from './model';

/**
 * Parameter curves are sorted [tick, value] points with linear interpolation between them.
 * Outside the first/last point the curve has its default value.
 */

function upperBound(points: readonly CurvePoint[], tick: number): number {
  // First index whose tick is > tick.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleCurve(points: readonly CurvePoint[], tick: number, def: number): number {
  const n = points.length;
  if (n === 0) return def;
  if (tick < points[0][0] || tick > points[n - 1][0]) return def;
  const i = upperBound(points, tick);
  if (i >= n) return points[n - 1][1];
  if (i === 0) return points[0][1];
  const [t0, v0] = points[i - 1];
  const [t1, v1] = points[i];
  if (t1 === t0) return v1;
  return v0 + ((v1 - v0) * (tick - t0)) / (t1 - t0);
}

/** Samples the curve at ascending ticks. `ticks` must be sorted ascending. */
export function sampleCurveSorted(points: readonly CurvePoint[], ticks: ArrayLike<number>, def: number, out: Float64Array | Float32Array): void {
  const n = points.length;
  if (n === 0) {
    out.fill(def, 0, ticks.length);
    return;
  }
  let i = 0;
  const first = points[0][0];
  const last = points[n - 1][0];
  for (let k = 0; k < ticks.length; k++) {
    const t = ticks[k];
    if (t < first || t > last) {
      out[k] = def;
      continue;
    }
    while (i < n - 1 && points[i + 1][0] <= t) i++;
    if (i >= n - 1) {
      out[k] = points[n - 1][1];
      continue;
    }
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    out[k] = t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
}

function clampValue(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Replaces the curve between the first and last tick of `segment` with the segment's
 * points, leaving the curve outside that range unchanged.
 */
export function writeSegment(
  points: readonly CurvePoint[],
  segment: readonly CurvePoint[],
  def: number,
  min = -Infinity,
  max = Infinity,
): CurvePoint[] {
  if (segment.length === 0) return points.slice() as CurvePoint[];
  const seg = dedupeSorted(
    segment
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [Math.round(p[0]), clampValue(p[1], min, max)] as CurvePoint)
      .sort((a, b) => a[0] - b[0]),
  );
  if (seg.length === 0) return points.slice() as CurvePoint[];
  const t0 = seg[0][0];
  const t1 = seg[seg.length - 1][0];
  const before = points.filter((p) => p[0] < t0 - 1);
  const after = points.filter((p) => p[0] > t1 + 1);
  const out: CurvePoint[] = [...before];
  const vBefore = sampleCurve(points, t0 - 1, def);
  const vAfter = sampleCurve(points, t1 + 1, def);
  if (before.length > 0 || vBefore !== def) out.push([t0 - 1, vBefore]);
  out.push(...seg);
  if (after.length > 0 || vAfter !== def) out.push([t1 + 1, vAfter]);
  out.push(...after);
  return simplify(out, def);
}

/** Resets the curve to its default value between t0 and t1. */
export function eraseRange(points: readonly CurvePoint[], t0: number, t1: number, def: number): CurvePoint[] {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  return writeSegment(points, [
    [a, def],
    [b, def],
  ], def);
}

function dedupeSorted(points: CurvePoint[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0]) last[1] = p[1];
    else out.push([p[0], p[1]]);
  }
  return out;
}

/** Removes points that do not change the shape of the curve. */
export function simplify(points: readonly CurvePoint[], def: number, epsilon = 1e-9): CurvePoint[] {
  let pts = dedupeSorted([...points].sort((a, b) => a[0] - b[0]) as CurvePoint[]);
  let changed = true;
  while (changed) {
    changed = false;
    const out: CurvePoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = out[out.length - 1];
      const next = pts[i + 1];
      const isFirst = out.length === 0;
      const isLast = i === pts.length - 1;
      // Leading/trailing default points are redundant when their neighbour is also default.
      if (isFirst && Math.abs(p[1] - def) < epsilon && (next === undefined || Math.abs(next[1] - def) < epsilon)) {
        changed = true;
        continue;
      }
      if (isLast && Math.abs(p[1] - def) < epsilon && (prev === undefined || Math.abs(prev[1] - def) < epsilon)) {
        changed = true;
        continue;
      }
      // Middle point on a straight line between neighbours.
      if (prev && next) {
        const [ta, va] = prev;
        const [tb, vb] = next;
        const expected = tb === ta ? vb : va + ((vb - va) * (p[0] - ta)) / (tb - ta);
        if (Math.abs(expected - p[1]) < epsilon) {
          changed = true;
          continue;
        }
      }
      out.push(p);
    }
    pts = out;
  }
  return pts;
}

/** Shifts all points in [t0, t1] by `delta` ticks (used when moving notes with their curves). */
export function shiftTicks(points: readonly CurvePoint[], delta: number): CurvePoint[] {
  return points.map((p) => [p[0] + delta, p[1]] as CurvePoint);
}
