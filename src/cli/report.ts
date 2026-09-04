import type { AnalysisReport, Classification } from "../types.js";

function label(item: Classification): string {
  const location = item.line ? `${item.path}:${item.line}` : item.path;
  return `${item.kind.padEnd(23)} ${location}`;
}

function counts(items: Classification[]): string[] {
  const byKind = new Map<string, number>();
  for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  return [...byKind]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `  ${String(count).padStart(4)}  ${kind}`);
}

function section(title: string, items: Classification[], verbose: boolean): string[] {
  const output = [`${title}: ${items.length}`];
  if (!verbose) return [...output, ...counts(items)];
  for (const item of items) {
    output.push(`  ${label(item)}`);
    output.push(`    Reason: ${item.reason}`);
    for (const detail of item.details ?? []) output.push(`    - ${detail}`);
  }
  return output;
}

export function formatReport(report: AnalysisReport, verbose = false): string {
  return [
    `Repository: ${report.root}`,
    "",
    ...section("Mechanical changes (B)", report.mechanical, verbose),
    "",
    ...section("Behavioral changes (A)", report.behavioral, verbose),
    "",
    ...section("Ambiguous (defaults to A)", report.ambiguous, verbose),
  ].join("\n");
}

export function formatDryRun(report: AnalysisReport, verbose = false): string {
  return [
    formatReport(report, verbose),
    "",
    "Dry-run split plan:",
    `  commit A candidates: ${report.behavioral.length + report.ambiguous.length}`,
    `  commit B candidates: ${report.mechanical.length}`,
    "  Git index modified: no",
    "",
    "Phase 1 reports a safe plan only. Patch/index staging is scheduled for Phase 2.",
  ].join("\n");
}
