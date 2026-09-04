export { analyzeRepository } from "./classifier/classify.js";
export { collectChanges } from "./git/collectChanges.js";
export { formatDryRun, formatReport } from "./cli/report.js";
export { buildSplitPlan } from "./planner/buildSplitPlan.js";
export { stageSplitPart } from "./planner/stageSplitPart.js";
export { writeSplitArtifacts } from "./planner/writeSplitArtifacts.js";
export type {
  PatchMetadata,
  SplitManifest,
  SplitPlan,
} from "./planner/types.js";
export type {
  AnalysisReport,
  Classification,
  ClassificationKind,
  ClassificationSide,
  WorkingTreeChange,
} from "./types.js";
