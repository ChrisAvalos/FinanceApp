/**
 * Tax-time export panel — Phase 7.4.
 *
 * Annual roll-up by tax bucket + CSV export. The bucket→category map
 * is shown so Chris can see exactly what's classified as
 * deductible / income / charitable / business / etc.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";

export default function TaxPanel() {
  // Default to current calendar year — that's where this year's
  // transactions are landing, so a year-to-date view is the most
  // useful default. (Used to default to currentYear-1 under the
  // assumption "you're filing last year's taxes" but that means new
  // users with only this year's data see all $0 buckets.)
  const [year, setYear] = useState(new Date().getFullYear());
  const report = useQuery({ queryKey: ["taxReport", year], queryFn: () => api.taxReport(year) });

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={report.data?.generated_at ?? null} label="Roll-up computed" />
      </div>
      <div className="bg-card border border-border rounded-md shadow-card mb-5 p-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text">Tax-year roll-up</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Categorized buckets ready for upload to TurboTax / your CPA. CSV export includes every transaction with the tax bucket attached.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="px-2 py-1 text-xs border border-border rounded bg-card">
            {Array.from({ length: 6 }).map((_, i) => {
              const y = new Date().getFullYear() - i;
              return <option key={y} value={y}>{y}</option>;
            })}
          </select>
          <a
            href={api.taxExportCsvUrl(year)}
            className="px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white"
          >
            Download CSV
          </a>
        </div>
      </div>

      {/* Skeleton-shaped placeholder while the year's report builds.
          The shape mirrors the eventual hero row + bucket table so the
          page doesn't shift when data lands. */}
      {report.isLoading && (
        <>
          <SkelHeroRow count={3} />
          <div className="bg-card border border-border rounded-md shadow-card overflow-hidden mb-5">
            <div className="px-4 py-2 border-b border-border bg-slate-50">
              <h3 className="text-sm font-semibold text-text">Tax buckets</h3>
            </div>
            <table className="w-full">
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <SkelTableRow key={i} cols={3} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {report.data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
            <div className="bg-card border border-border rounded-md p-4 shadow-card">
              <div className="text-xs text-text-muted uppercase tracking-wide">Total inflow · {year}</div>
              <div className="text-2xl font-semibold tabular-nums mt-1 text-inflow">
                <CountUp value={report.data.grand_total_inflow_cents} format={fmtCents} />
              </div>
            </div>
            <div className="bg-card border border-border rounded-md p-4 shadow-card">
              <div className="text-xs text-text-muted uppercase tracking-wide">Total outflow · {year}</div>
              <div className="text-2xl font-semibold tabular-nums mt-1 text-outflow">
                <CountUp value={report.data.grand_total_outflow_cents} format={fmtCents} />
              </div>
            </div>
            <div className="bg-card border border-border rounded-md p-4 shadow-card">
              <div className="text-xs text-text-muted uppercase tracking-wide">Untagged outflow</div>
              <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
                <CountUp value={report.data.untagged_total_cents} format={fmtCents} />
              </div>
              <div className="text-[11px] text-text-soft mt-0.5">{report.data.untagged_txn_count} txns to categorize</div>
              {report.data.untagged_txn_count > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // One-shot handoff: TransactionsContent reads + clears
                    // this flag on mount and pre-applies the filter.
                    window.sessionStorage.setItem("txn-only-uncategorized", "1");
                    window.location.hash = "#transactions";
                  }}
                  className="mt-2 text-[11px] font-semibold text-brand hover:underline"
                >
                  Categorize unmapped →
                </button>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-md shadow-card overflow-hidden mb-5">
            <div className="px-4 py-2 border-b border-border bg-slate-50">
              <h3 className="text-sm font-semibold text-text">Tax buckets</h3>
            </div>
            <table className="w-full">
              <thead className="bg-hover border-b border-border">
                <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
                  <th className="px-4 py-2 text-left">Bucket</th>
                  <th className="px-4 py-2 text-right">Txns</th>
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.data.by_bucket.map((b) => (
                  <tr key={b.bucket} className="border-b border-border last:border-0 hover:bg-hover">
                    <td className="px-4 py-2 text-sm font-semibold">{b.bucket}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums">{b.txn_count}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums font-semibold">{fmtCents(b.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.data.untagged_top_categories.length > 0 && (
            <div className="bg-card border border-border rounded-md shadow-card p-4">
              <h3 className="text-sm font-semibold text-text mb-2">Categorized but not tax-mapped</h3>
              <p className="text-xs text-text-muted mb-3">
                These categories already have a label but aren't wired to any
                tax bucket. Most are intentionally personal/non-deductible
                (Transfer, Credit card payment, Groceries, etc.). The total
                shown here is outflow only — inflows are excluded.
              </p>
              <ul className="text-xs space-y-1">
                {report.data.untagged_top_categories.map(([name, cents]) => (
                  <li key={name} className="flex justify-between">
                    <span>{name}</span>
                    <span className="tabular-nums text-text-muted">{fmtCents(cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
