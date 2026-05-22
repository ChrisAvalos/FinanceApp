/**
 * ProjectionChart — Wave G-13 mobile port.
 *
 * Pure-RN-SVG multi-line projection chart. Mirrors the web component
 * at web/src/components/ProjectionChart.tsx — same series colors,
 * same dashed-baseline overlay, same nice-tick Y-axis snapping, but
 * adapted for React Native (no DOM, no SVG <text> CSS classes, no
 * hover tooltip — we use a tap-to-select interaction instead since
 * mobile has no mouse).
 *
 * Why SVG instead of canvas
 * -------------------------
 * react-native-svg renders to native UIView/AndroidView paths, which
 * means the lines stay crisp on every screen density and we get the
 * same SMIL-style animation primitives the web SVG path enables.
 * Canvas would force pixel rendering and lose that.
 */
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { G, Line, Path, Rect, Svg, Text as SvgText } from "react-native-svg";
import type { ProjectionPoint } from "../api/client";
import { C, fmtCents } from "../theme";

export interface ProjectionChartProps {
  scenario: ProjectionPoint[];
  baseline?: ProjectionPoint[] | null;
  width: number;
  height: number;
}

const SERIES_COLORS = {
  net:        { stroke: "#1b2430", label: "Net worth",   width: 3 },
  checking:   { stroke: "#117aca", label: "Checking",    width: 2 },
  savings:    { stroke: "#00754a", label: "Savings",     width: 2 },
  investment: { stroke: "#7B3F00", label: "Investments", width: 2 },
} as const;
type SeriesKey = keyof typeof SERIES_COLORS;
const SERIES_KEYS: SeriesKey[] = ["net", "checking", "savings", "investment"];

function pointValue(p: ProjectionPoint, key: SeriesKey): number {
  switch (key) {
    case "net":        return p.net_cents;
    case "checking":   return p.checking_cents;
    case "savings":    return p.savings_cents;
    case "investment": return p.investment_cents;
  }
}

function _formatTick(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  if (abs >= 100_000_00) return `${sign}$${(abs / 100_000_00).toFixed(1)}M`;
  if (abs >= 1000_00) return `${sign}$${(abs / 1000_00).toFixed(0)}K`;
  return `${sign}$${(abs / 100).toFixed(0)}`;
}

function _formatMonth(idx: number): string {
  if (idx === 0) return "Today";
  if (idx === 12) return "1 yr";
  if (idx === 24) return "2 yr";
  if (idx % 12 === 0) return `${idx / 12} yr`;
  return `+${idx}mo`;
}

export default function ProjectionChart({
  scenario,
  baseline,
  width,
  height,
}: ProjectionChartProps) {
  // Selected month-index — tap-to-select replaces web hover.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const M = { top: 14, right: 48, bottom: 30, left: 52 };
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  const { yMin, yMax, xMax } = useMemo(() => {
    const points: ProjectionPoint[] = [...scenario, ...(baseline ?? [])];
    if (points.length === 0) return { yMin: 0, yMax: 1, xMax: 1 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      for (const k of SERIES_KEYS) {
        const v = pointValue(p, k);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    const range = hi - lo || 1;
    return {
      yMin: lo - range * 0.1,
      yMax: hi + range * 0.1,
      xMax: Math.max(...points.map((p) => p.month_index)),
    };
  }, [scenario, baseline]);

  const xOf = (idx: number) => (idx / xMax) * innerW;
  const yOf = (v: number) =>
    innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  function _linePath(series: ProjectionPoint[], key: SeriesKey): string {
    if (series.length === 0) return "";
    const segs: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const x = xOf(series[i].month_index);
      const y = yOf(pointValue(series[i], key));
      segs.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return segs.join(" ");
  }

  // Snap Y ticks to nice round numbers — matches the web side.
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    const rawStep = range / 4; // 5 ticks total
    const exp = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(rawStep), 1))));
    const mant = rawStep / exp;
    let niceMant: number;
    if (mant < 1.5) niceMant = 1;
    else if (mant < 3.5) niceMant = 2;
    else if (mant < 7.5) niceMant = 5;
    else niceMant = 10;
    const step = niceMant * exp;
    const tickLo = Math.ceil(yMin / step) * step;
    const ticks: number[] = [];
    for (let v = tickLo; v <= yMax + 1; v += step) ticks.push(v);
    if (yMin < 0 && yMax > 0 && !ticks.some((t) => Math.abs(t) < 1)) ticks.push(0);
    return ticks.sort((a, b) => a - b);
  }, [yMin, yMax]);

  const xTicks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= xMax; i += 6) out.push(i);
    if (out[out.length - 1] !== xMax) out.push(xMax);
    return out;
  }, [xMax]);

  const hasBaselineOverlay = useMemo(() => {
    if (!baseline) return false;
    if (baseline.length !== scenario.length) return true;
    for (let i = 0; i < scenario.length; i++) {
      if (baseline[i].net_cents !== scenario[i].net_cents) return true;
    }
    return false;
  }, [scenario, baseline]);

  const selected = selectedIdx != null
    ? scenario.find((p) => p.month_index === selectedIdx)
    : null;

  function _tap(e: { nativeEvent: { locationX: number } }) {
    const rawX = e.nativeEvent.locationX - M.left;
    if (rawX < 0 || rawX > innerW) {
      setSelectedIdx(null);
      return;
    }
    const fraction = rawX / innerW;
    const idx = Math.round(fraction * xMax);
    setSelectedIdx(idx);
  }

  return (
    <View>
      <Pressable onPress={_tap}>
        <Svg width={width} height={height}>
          <G x={M.left} y={M.top}>
            {/* Y grid */}
            {yTicks.map((t, i) => (
              <G key={`yt-${i}`}>
                <Line x1={0} x2={innerW} y1={yOf(t)} y2={yOf(t)} stroke={C.border} strokeWidth={1} />
                <SvgText
                  x={-6}
                  y={yOf(t) + 4}
                  textAnchor="end"
                  fontSize={10}
                  fill={C.textSoft}
                >
                  {_formatTick(t)}
                </SvgText>
              </G>
            ))}

            {/* Zero line */}
            {yMin < 0 && yMax > 0 && (
              <Line
                x1={0}
                x2={innerW}
                y1={yOf(0)}
                y2={yOf(0)}
                stroke={C.outflow}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            )}

            {/* X labels */}
            {xTicks.map((tx) => (
              <G key={`xt-${tx}`}>
                <Line x1={xOf(tx)} x2={xOf(tx)} y1={innerH} y2={innerH + 4} stroke={C.textMuted} />
                <SvgText
                  x={xOf(tx)}
                  y={innerH + 16}
                  textAnchor="middle"
                  fontSize={10}
                  fill={C.textMuted}
                >
                  {_formatMonth(tx)}
                </SvgText>
              </G>
            ))}

            {/* Baseline (dashed) */}
            {hasBaselineOverlay && baseline && SERIES_KEYS.map((k) => (
              <Path
                key={`bl-${k}`}
                d={_linePath(baseline, k)}
                fill="none"
                stroke={SERIES_COLORS[k].stroke}
                strokeWidth={SERIES_COLORS[k].width}
                strokeDasharray="5 4"
                opacity={0.45}
              />
            ))}

            {/* Scenario (solid) */}
            {SERIES_KEYS.map((k) => (
              <Path
                key={`sc-${k}`}
                d={_linePath(scenario, k)}
                fill="none"
                stroke={SERIES_COLORS[k].stroke}
                strokeWidth={SERIES_COLORS[k].width}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {/* Selected indicator — vertical line + dots */}
            {selectedIdx != null && selected && (
              <G>
                <Line
                  x1={xOf(selectedIdx)}
                  x2={xOf(selectedIdx)}
                  y1={0}
                  y2={innerH}
                  stroke={C.textMuted}
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                {SERIES_KEYS.map((k) => (
                  <G key={`hd-${k}`}>
                    <Rect
                      x={xOf(selectedIdx) - 4}
                      y={yOf(pointValue(selected, k)) - 4}
                      width={8}
                      height={8}
                      rx={4}
                      ry={4}
                      fill="#ffffff"
                      stroke={SERIES_COLORS[k].stroke}
                      strokeWidth={2}
                    />
                  </G>
                ))}
              </G>
            )}
          </G>
        </Svg>
      </Pressable>

      {/* Below-chart selected detail */}
      {selectedIdx != null && selected && (
        <View style={chartStyles.tooltip}>
          <Text style={chartStyles.tooltipLabel}>{_formatMonth(selectedIdx)}</Text>
          <View style={chartStyles.tooltipGrid}>
            {SERIES_KEYS.map((k) => (
              <View key={k} style={chartStyles.tooltipRow}>
                <View style={[chartStyles.tooltipDot, { backgroundColor: SERIES_COLORS[k].stroke }]} />
                <Text style={chartStyles.tooltipName}>{SERIES_COLORS[k].label}</Text>
                <Text
                  style={[
                    chartStyles.tooltipValue,
                    { color: pointValue(selected, k) < 0 ? C.outflow : C.text },
                  ]}
                >
                  {fmtCents(pointValue(selected, k))}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Legend */}
      <View style={chartStyles.legend}>
        {SERIES_KEYS.map((k) => (
          <View key={k} style={chartStyles.legendItem}>
            <View
              style={{
                width: 14,
                height: 3,
                borderRadius: 2,
                backgroundColor: SERIES_COLORS[k].stroke,
              }}
            />
            <Text style={chartStyles.legendLabel}>{SERIES_COLORS[k].label}</Text>
          </View>
        ))}
        {hasBaselineOverlay && (
          <Text style={chartStyles.legendNote}>Dashed = status quo</Text>
        )}
      </View>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  tooltip: {
    marginTop: 8,
    padding: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  tooltipLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tooltipGrid: { marginTop: 4 },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  tooltipDot: { width: 8, height: 8, borderRadius: 2, marginRight: 6 },
  tooltipName: { flex: 1, color: C.textMuted, fontSize: 12 },
  tooltipValue: { fontSize: 12, fontWeight: "700" },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 8,
    rowGap: 4,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendLabel: { color: C.textMuted, fontSize: 11 },
  legendNote: { color: C.textSoft, fontSize: 11, fontStyle: "italic" },
});
