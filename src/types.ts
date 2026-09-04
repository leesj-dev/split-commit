export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface WorkingTreeChange {
  status: ChangeStatus;
  oldPath?: string;
  newPath?: string;
  oldContent?: string;
  newContent?: string;
  gitSimilarity?: number;
  untracked?: boolean;
}

export type ClassificationSide = "mechanical" | "behavioral" | "ambiguous";

export type ClassificationKind =
  | "file-move"
  | "import-path-update"
  | "export-path-update"
  | "barrel-update"
  | "source-modification"
  | "source-addition"
  | "source-deletion"
  | "non-source-change"
  | "unresolved-module-update"
  | "unsafe-module-update"
  | "unsupported-formatting";

export interface Classification {
  side: ClassificationSide;
  kind: ClassificationKind;
  path: string;
  line?: number;
  reason: string;
  details?: string[];
  confidence?: "high" | "none";
}

export interface AnalysisReport {
  root: string;
  mechanical: Classification[];
  behavioral: Classification[];
  ambiguous: Classification[];
}

export interface ConfirmedMove {
  oldPath: string;
  newPath: string;
  oldAbsolutePath: string;
  newAbsolutePath: string;
  sourceChange: WorkingTreeChange | null;
  reason: string;
  details: string[];
}
