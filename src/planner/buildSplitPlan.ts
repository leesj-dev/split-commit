import { createHash } from "node:crypto";
import path from "node:path";
import { analyzeRepositoryDetailed } from "../classifier/classify.js";
import {
  hasAnyAstChange,
  hasBehavioralRemainder,
  type ModuleSpecifierEdit,
} from "../classifier/importPathUpdate.js";
import { runGit } from "../git/runGit.js";
import {
  buildSequentialPatches,
  readWorkingTreeEntry,
  type IndexOperation,
} from "../git/temporaryIndex.js";
import { isSourcePath } from "../ts/astNormalizer.js";
import type { WorkingTreeChange } from "../types.js";
import type { PatchMetadata, SplitPlan } from "./types.js";

interface TextReplacement {
  start: number;
  end: number;
  expected: string;
  replacement: string;
}

function replaceRanges(content: string, replacements: TextReplacement[]): string {
  let result = content;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    if (content.slice(replacement.start, replacement.end) !== replacement.expected) {
      throw new Error("Source changed while building a semantic module-path patch");
    }
    result =
      result.slice(0, replacement.start) +
      replacement.replacement +
      result.slice(replacement.end);
  }
  return result;
}

function aContent(newContent: string, edits: ModuleSpecifierEdit[]): Buffer {
  return Buffer.from(
    replaceRanges(
      newContent,
      edits.map((edit) => ({
        start: edit.newStart,
        end: edit.newEnd,
        expected: edit.newRaw,
        replacement: edit.oldRaw,
      })),
    ),
  );
}

function wholeWorkingTreeChange(
  root: string,
  change: WorkingTreeChange,
): IndexOperation[] {
  const operations: IndexOperation[] = [];
  if (change.oldPath && (change.status === "deleted" || change.status === "renamed")) {
    operations.push({ kind: "remove", path: change.oldPath });
  }
  if (change.newPath && change.status !== "deleted") {
    const entry = readWorkingTreeEntry(root, change.newPath);
    operations.push({ kind: "set", path: change.newPath, ...entry });
  }
  return operations;
}

function metadata(
  patch: Buffer,
  baseTreeId: string,
  treeId: string,
): PatchMetadata {
  const text = patch.toString("utf8");
  return {
    bytes: patch.length,
    files: (text.match(/^diff --git /gm) ?? []).length,
    sha256: createHash("sha256").update(patch).digest("hex"),
    baseTreeId,
    treeId,
  };
}

export function buildSplitPlan(cwd = process.cwd()): SplitPlan {
  const analysis = analyzeRepositoryDetailed(cwd);
  const { root, changes, moves, moduleAnalyses, report } = analysis;
  const operationsA: IndexOperation[] = [];
  const finalOperations: IndexOperation[] = [];
  const consumedOldPaths = new Set(moves.map((move) => move.oldPath));
  const consumedNewPaths = new Set(moves.map((move) => move.newPath));

  for (const change of changes) {
    finalOperations.push(...wholeWorkingTreeChange(root, change));
  }

  for (const change of changes) {
    const oldPath = change.oldPath?.split(path.sep).join("/");
    const newPath = change.newPath?.split(path.sep).join("/");
    if (
      (oldPath ? consumedOldPaths.has(oldPath) : false) ||
      (newPath ? consumedNewPaths.has(newPath) : false)
    ) {
      continue;
    }

    const candidatePath = change.newPath ?? change.oldPath;
    const moduleAnalysis = moduleAnalyses.get(change);
    if (
      candidatePath &&
      isSourcePath(candidatePath) &&
      change.status === "modified" &&
      change.oldContent !== undefined &&
      change.newContent !== undefined &&
      moduleAnalysis
    ) {
      const hasRemainder = hasBehavioralRemainder(
        candidatePath,
        change.oldContent,
        change.newContent,
        moduleAnalysis,
      );
      const formattingOnly =
        moduleAnalysis.mechanical.length === 0 &&
        moduleAnalysis.ambiguous.length === 0 &&
        !hasAnyAstChange(candidatePath, change.oldContent, change.newContent);
      const belongsToA =
        hasRemainder || moduleAnalysis.ambiguous.length > 0 || formattingOnly;

      if (belongsToA) {
        operationsA.push({
          kind: "set",
          path: candidatePath,
          mode: change.newMode ?? change.oldMode ?? "100644",
          content: aContent(change.newContent, moduleAnalysis.mechanicalEdits),
        });
      }
      continue;
    }

    operationsA.push(...wholeWorkingTreeChange(root, change));
  }

  const baseCommit = runGit(root, ["rev-parse", "HEAD"]).trim();
  const baseTreeId = runGit(root, ["rev-parse", `${baseCommit}^{tree}`]).trim();
  const { a: builtA, b: builtB } = buildSequentialPatches(
    root,
    operationsA,
    finalOperations,
  );
  return {
    root,
    baseCommit,
    report,
    a: {
      ...builtA,
      metadata: metadata(builtA.patch, baseTreeId, builtA.treeId),
    },
    b: {
      ...builtB,
      metadata: metadata(builtB.patch, builtA.treeId, builtB.treeId),
    },
  };
}
