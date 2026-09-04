import path from "node:path";
import ts from "typescript";
import type { ConfirmedMove } from "../types.js";
import type { ProjectContext } from "./projectLoader.js";

export interface ResolutionPair {
  oldTarget: string | null;
  newTarget: string | null;
  equivalent: boolean;
}

function canonical(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

export function resolveModule(
  project: ProjectContext,
  snapshot: "old" | "new",
  specifier: string,
  containingFile: string,
): string | null {
  const host = snapshot === "old" ? project.oldHost : project.newHost;
  const result = ts.resolveModuleName(
    specifier,
    containingFile,
    project.compilerOptions,
    host,
  );
  return result.resolvedModule ? canonical(result.resolvedModule.resolvedFileName) : null;
}

export function compareResolutions(
  project: ProjectContext,
  oldSpecifier: string,
  oldContainingFile: string,
  newSpecifier: string,
  newContainingFile: string,
  moves: ConfirmedMove[],
): ResolutionPair {
  const oldTarget = resolveModule(project, "old", oldSpecifier, oldContainingFile);
  const newTarget = resolveModule(project, "new", newSpecifier, newContainingFile);
  if (!oldTarget || !newTarget) return { oldTarget, newTarget, equivalent: false };
  if (oldTarget === newTarget) return { oldTarget, newTarget, equivalent: true };

  const equivalent = moves.some(
    (move) =>
      canonical(move.oldAbsolutePath) === oldTarget &&
      canonical(move.newAbsolutePath) === newTarget,
  );
  return { oldTarget, newTarget, equivalent };
}

export function displayTarget(root: string, target: string | null): string {
  if (!target) return "unresolved";
  const relative = path.relative(root, target);
  return relative.startsWith("..") ? target : relative.split(path.sep).join("/");
}
