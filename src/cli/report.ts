import type { AnalysisReport, Classification } from "../types.js";
import type { SplitPlan } from "../planner/types.js";
import type {
  ApplySplitResult,
  ResolvedCommitMessages,
} from "../planner/applySplit.js";

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

function formatPatch(label: string, metadata: SplitPlan["a"]["metadata"]): string {
  return `  ${label}: ${metadata.files} files, ${metadata.bytes} bytes, sha256 ${metadata.sha256}`;
}

export function formatDryRun(plan: SplitPlan, verbose = false): string {
  return [
    formatReport(plan.report, verbose),
    "",
    "Dry-run split plan:",
    `  base commit: ${plan.baseCommit}`,
    `  commit A candidates: ${plan.report.behavioral.length + plan.report.ambiguous.length}`,
    `  commit B candidates: ${plan.report.mechanical.length}`,
    formatPatch("commit-a.patch", plan.a.metadata),
    formatPatch("commit-b.patch", plan.b.metadata),
    "  Git index modified: no",
  ].join("\n");
}

export function formatWrittenPlan(
  plan: SplitPlan,
  outputDirectory: string,
  verbose = false,
): string {
  return [
    formatReport(plan.report, verbose),
    "",
    `Patch artifacts written to ${outputDirectory}`,
    formatPatch("commit-a.patch", plan.a.metadata),
    formatPatch("commit-b.patch", plan.b.metadata),
    "Git index modified: no",
  ].join("\n");
}

export function formatApplyDryRun(
  plan: SplitPlan,
  messages: ResolvedCommitMessages,
  verbose = false,
): string {
  return [
    formatDryRun(plan, verbose),
    "",
    "Apply dry-run:",
    `  commit A message: ${JSON.stringify(messages.a)}`,
    `  commit B message: ${JSON.stringify(messages.b)}`,
    `  commit A: ${plan.a.patch.length > 0 ? "would commit" : "would skip (empty)"}`,
    `  commit B: ${plan.b.patch.length > 0 ? "would commit after A" : "would skip (empty)"}`,
    "  Commits created: no",
  ].join("\n");
}

export function formatApplyResult(result: ApplySplitResult): string {
  const line = (label: "A" | "B", commit: ApplySplitResult["a"]): string =>
    commit.committed
      ? `Commit ${label}: ${commit.commitId} ${commit.message}`
      : `Commit ${label}: skipped (empty); reserved message ${JSON.stringify(commit.message)}`;
  return [
    line("A", result.a),
    line("B", result.b),
    `Final HEAD: ${result.finalCommit}`,
  ].join("\n");
}
