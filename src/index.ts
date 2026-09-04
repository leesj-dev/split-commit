export { analyzeRepository } from "./classifier/classify.js";
export { collectChanges } from "./git/collectChanges.js";
export { formatDryRun, formatReport } from "./cli/report.js";
export type {
  AnalysisReport,
  Classification,
  ClassificationKind,
  ClassificationSide,
  WorkingTreeChange,
} from "./types.js";
