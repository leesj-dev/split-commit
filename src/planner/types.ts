import type { AnalysisReport } from "../types.js";
import type { BuiltPatch } from "../git/temporaryIndex.js";

export interface PatchMetadata {
  bytes: number;
  files: number;
  sha256: string;
  baseTreeId: string;
  treeId: string;
}

export interface SplitPlan {
  root: string;
  baseCommit: string;
  report: AnalysisReport;
  a: BuiltPatch & { metadata: PatchMetadata };
  b: BuiltPatch & { metadata: PatchMetadata };
}

export interface SplitManifest {
  version: 1;
  generatedAt: string;
  repository: string;
  baseCommit: string;
  policy: {
    ambiguousDestination: "A";
    order: ["A", "B"];
  };
  patches: {
    a: PatchMetadata & { file: "commit-a.patch" };
    b: PatchMetadata & { file: "commit-b.patch" };
  };
}
