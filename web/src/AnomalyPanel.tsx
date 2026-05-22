/**
 * Anomaly / unusual-transaction panel — Phase 9.3.
 *
 * Statistical baseline per category over the trailing window;
 * surfaces transactions ≥ Nσ above the per-category mean. The
 * threshold slider lets the user trade precision for recall.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";

export default function AnomalyPanel() {
  const qc = useQueryClient();
  const [days, setDays] = useState(90);
  const [sigma, setSigma] = useState(3.0);
  const scan = useQuery({
    queryKey: ["anomalyScan", days, sigma],
    queryFn: () => api.anomalyScan(days, sigma, false),
  });
  const fire = useMutation({
    mutationFn: () => api.anomalyScan(days, sigma, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["anomalyScan"] }),
  });

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={scan.data?.generated_at ?? null} label="Last scan" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Anomalies found</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">{scan.data?.anomalies.length ?? 0}</div>
          <div className="text-[11px] text-text-soft mt-0.5">≥{sigma.toFixed(1)}σ above category mean</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Window</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{days}d</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Scanned</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{scan.data?.transactions_scanned ?? 0}</div>
          <div className="text-[11px] text-text-soft mt-0.5">Outflow transactions</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Notifications</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{scan.data?.notifications_created ?? 0}</div>
          <div className="text-[11px] text-text-soft mt-0.5">From most recent fire</div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md shadow-card mb-5 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-text-muted">Window:</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="px-2 py-1 text-xs border border-border rounded">
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>1 year</option>
              <option value={730}>2 years</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm flex-1 min-w-[200px]">
            <span className="text-text-muted whitespace-nowrap">Threshold: {sigma.toFixed(1)}σ</span>
            <input type="range" min={1.5} max={6} step={0.5} value={sigma} onChange={(e) => setSigma(Number(e.target.value))} className="flex-1" />
          </label>
          <button
            onClick={() => fire.mutate()}
            disabled={fire.isPending}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50"
          >
            {fire.isPending ? "Firing…" : "Fire notifications for top 10"}
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-right">σ</th>
              <th className="px-4 py-2 text-left">Why</th>
            </tr>
          </thead>
          <tbody>
            {scan.isLoading && <tr><td colSpan={6} className="p-6 text-center text-sm text-text-muted">Scanning…</td></tr>}
            {scan.data?.anomalies.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-sm text-text-muted">No anomalies at this threshold. Try lowering σ to increase recall.</td></tr>}
            {scan.data?.anomalies.map((a) => (
              <tr key={a.transaction_id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">{new Date(a.posted_date).toLocaleDateString()}</td>
                <td className="px-4 py-2 text-sm font-medium">{a.description || "—"}</td>
                <td className="px-4 py-2 text-xs text-text-muted">{a.category_name || "—"}</td>
                <td className="px-4 py-2 text-right text-sm tabular-nums font-semibold text-outflow">{fmtCents(a.amount_cents)}</td>
                <td className="px-4 py-2 text-right text-sm tabular-nums font-semibold text-warn">{a.sigma.toFixed(1)}</td>
                <td className="px-4 py-2 text-xs text-text-muted">{a.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
