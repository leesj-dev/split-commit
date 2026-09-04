export { analyzeRepository } from "./classifier/classify.js";
export { collectChanges } from "./git/collectChanges.js";
export { formatDryRun, formatReport } from "./cli/report.js";
export { buildSplitPlan } from "./planner/buildSplitPlan.js";
export type { BuildSplitPlanOptions } from "./planner/buildSplitPlan.js";
export {
  ambiguousClassificationId,
  reviewAmbiguous,
} from "./reviewer/aiReviewer.js";
export type {
  AmbiguousReviewerOptions,
  AmbiguousReviewerProvider,
} from "./reviewer/aiReviewer.js";
export {
  applySplit,
  DEFAULT_COMMIT_MESSAGE_A,
  DEFAULT_COMMIT_MESSAGE_B,
  resolveCommitMessages,
} from "./planner/applySplit.js";
export { stageSplitPart } from "./planner/stageSplitPart.js";
export { writeSplitArtifacts } from "./planner/writeSplitArtifacts.js";
export type {
  PatchMetadata,
  SplitManifest,
  SplitPlan,
} from "./planner/types.js";
export type {
  AppliedCommit,
  ApplySplitResult,
  ResolvedCommitMessages,
} from "./planner/applySplit.js";
export type {
  AnalysisReport,
  AmbiguousReviewDecision,
  AmbiguousReviewResult,
  Classification,
  ClassificationKind,
  ClassificationSide,
  ReviewConfidence,
  ReviewDestination,
  WorkingTreeChange,
} from "./types.js";
