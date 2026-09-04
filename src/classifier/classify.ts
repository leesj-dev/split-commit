import path from "node:path";
import type {
  AnalysisReport,
  Classification,
  WorkingTreeChange,
} from "../types.js";
import { collectChanges } from "../git/collectChanges.js";
import { detectRenames } from "../git/detectRenames.js";
import { isSourcePath } from "../ts/astNormalizer.js";
import { loadProject } from "../ts/projectLoader.js";
import { classifyFileMove } from "./fileMove.js";
import {
  analyzeModuleUpdates,
  hasAnyAstChange,
  hasBehavioralRemainder,
} from "./importPathUpdate.js";

function displayPath(change: WorkingTreeChange): string {
  if (change.status === "renamed") {
    return `${change.oldPath} → ${change.newPath}`;
  }
  return (change.newPath ?? change.oldPath ?? "unknown").split(path.sep).join("/");
}

function behavioral(
  change: WorkingTreeChange,
  kind: Classification["kind"],
  reason: string,
  details?: string[],
): Classification {
  return {
    side: "behavioral",
    kind,
    path: displayPath(change),
    reason,
    ...(details ? { details } : {}),
    confidence: "none",
  };
}

export function analyzeRepository(cwd = process.cwd()): AnalysisReport {
  const { root, changes } = collectChanges(cwd);
  const project = loadProject(root, changes);
  const { confirmed: moves, rejected } = detectRenames(root, changes, project);
  const mechanical = moves.map(classifyFileMove);
  const behavioralChanges: Classification[] = [];
  const ambiguous: Classification[] = [];

  const consumedOldPaths = new Set(moves.map((move) => move.oldPath));
  const consumedNewPaths = new Set(moves.map((move) => move.newPath));

  for (const change of changes) {
    const oldPath = change.oldPath?.split(path.sep).join("/");
    const newPath = change.newPath?.split(path.sep).join("/");
    const isConsumedMove =
      (oldPath ? consumedOldPaths.has(oldPath) : false) ||
      (newPath ? consumedNewPaths.has(newPath) : false);
    if (isConsumedMove) continue;

    const candidatePath = change.newPath ?? change.oldPath;
    if (!candidatePath || !isSourcePath(candidatePath)) {
      behavioralChanges.push(
        behavioral(
          change,
          "non-source-change",
          "Phase 1 only certifies TypeScript/JavaScript structural changes",
        ),
      );
      continue;
    }

    if (
      change.status === "modified" &&
      change.oldContent !== undefined &&
      change.newContent !== undefined
    ) {
      const moduleAnalysis = analyzeModuleUpdates(root, change, project, moves);
      mechanical.push(...moduleAnalysis.mechanical);
      ambiguous.push(...moduleAnalysis.ambiguous);

      if (
        hasBehavioralRemainder(
          candidatePath,
          change.oldContent,
          change.newContent,
          moduleAnalysis,
        )
      ) {
        behavioralChanges.push(
          behavioral(
            change,
            "source-modification",
            "Normalized AST or comment content changed beyond recognized module-path updates",
            [
              "This may affect control flow, data flow, API shape, side effects, or tool directives",
              "Conservative policy assigns the complete unproven remainder to commit A",
            ],
          ),
        );
      } else if (
        moduleAnalysis.mechanical.length === 0 &&
        moduleAnalysis.ambiguous.length === 0 &&
        !hasAnyAstChange(candidatePath, change.oldContent, change.newContent)
      ) {
        ambiguous.push({
          side: "ambiguous",
          kind: "unsupported-formatting",
          path: displayPath(change),
          reason: "AST and comments are unchanged, but standalone formatting certification is deferred",
          details: ["Ambiguous changes are assigned to commit A by default"],
          confidence: "none",
        });
      }
      continue;
    }

    if (change.status === "added") {
      behavioralChanges.push(
        behavioral(change, "source-addition", "New source has no proven predecessor"),
      );
    } else if (change.status === "deleted") {
      behavioralChanges.push(
        behavioral(change, "source-deletion", "Deleted source has no proven successor"),
      );
    } else {
      behavioralChanges.push(
        behavioral(
          change,
          "source-modification",
          rejected.get(change) ??
            "Rename/move candidate failed conservative structural validation",
        ),
      );
    }
  }

  return { root, mechanical, behavioral: behavioralChanges, ambiguous };
}
