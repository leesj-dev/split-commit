import { ambiguousClassificationId } from "../reviewer/aiReviewer.js";
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

function section(
  title: string,
  items: Classification[],
  verbose: boolean,
  report?: AnalysisReport,
): string[] {
  const output = [`${title}: ${items.length}`];
  if (!verbose) return [...output, ...counts(items)];
  for (const item of items) {
    const decision = report?.aiReview?.decisions.find(
      (candidate) =>
        candidate.classificationId === ambiguousClassificationId(item),
    );
    output.push(
      `  ${label(item)}${decision ? ` -> ${decision.destination} by AI (${decision.confidence})` : ""}`,
    );
    output.push(`    Reason: ${item.reason}`);
    for (const detail of item.details ?? []) output.push(`    - ${detail}`);
    if (decision) output.push(`    - AI: ${decision.reason}`);
  }
  return output;
}

function destinations(report: AnalysisReport): { a: number; b: number } {
  if (!report.aiReview) return { a: report.ambiguous.length, b: 0 };
  let a = 0;
  let b = 0;
  for (const classification of report.ambiguous) {
    const destination = report.aiReview.decisions.find(
      (decision) =>
        decision.classificationId ===
        ambiguousClassificationId(classification),
    )?.destination;
    if (destination === "B") b += 1;
    else a += 1;
  }
  return { a, b };
}

export function formatReport(report: AnalysisReport, verbose = false): string {
  const reviewer = report.aiReview
    ? [
        report.aiReview.provider,
        report.aiReview.model ? `model ${report.aiReview.model}` : undefined,
        report.aiReview.effort ? `effort ${report.aiReview.effort}` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
    : undefined;
  const ambiguousTitle = report.aiReview
    ? `Ambiguous (AI-reviewed by ${reviewer})`
    : "Ambiguous (defaults to A)";
  return [
    `Repository: ${report.root}`,
    "",
    ...section("Mechanical changes (B)", report.mechanical, verbose),
    "",
    ...section("Behavioral changes (A)", report.behavioral, verbose),
    "",
    ...section(ambiguousTitle, report.ambiguous, verbose, report),
  ].join("\n");
}

function formatPatch(label: string, metadata: SplitPlan["a"]["metadata"]): string {
  return `  ${label}: ${metadata.files} files, ${metadata.bytes} bytes, sha256 ${metadata.sha256}`;
}

export function formatDryRun(plan: SplitPlan, verbose = false): string {
  const ambiguous = destinations(plan.report);
  return [
    formatReport(plan.report, verbose),
    "",
    "Dry-run split plan:",
    `  base commit: ${plan.baseCommit}`,
    `  commit A candidates: ${plan.report.behavioral.length + ambiguous.a}`,
    `  commit B candidates: ${plan.report.mechanical.length + ambiguous.b}`,
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
