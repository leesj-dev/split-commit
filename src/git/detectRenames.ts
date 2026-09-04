import path from "node:path";
import type { ConfirmedMove, WorkingTreeChange } from "../types.js";
import {
  extractStaticModuleReferences,
  findPathSensitiveConstructs,
  isSourcePath,
  semanticFingerprint,
} from "../ts/astNormalizer.js";
import { compareResolutions, displayTarget } from "../ts/moduleResolver.js";
import type { ProjectContext } from "../ts/projectLoader.js";

interface ProvisionalMove extends ConfirmedMove {
  oldContent: string;
  newContent: string;
  oldMode: string;
  newMode: string;
}

function slash(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function sourceEndpoints(changes: WorkingTreeChange[]): {
  deletions: WorkingTreeChange[];
  additions: WorkingTreeChange[];
  explicitRenames: WorkingTreeChange[];
} {
  return {
    deletions: changes.filter(
      (change) =>
        change.status === "deleted" &&
        Boolean(change.oldPath && isSourcePath(change.oldPath)),
    ),
    additions: changes.filter(
      (change) =>
        change.status === "added" &&
        Boolean(change.newPath && isSourcePath(change.newPath)),
    ),
    explicitRenames: changes.filter(
      (change) =>
        change.status === "renamed" &&
        Boolean(change.oldPath && change.newPath) &&
        isSourcePath(change.oldPath!) &&
        isSourcePath(change.newPath!),
    ),
  };
}

function makeProvisional(
  root: string,
  sourceChange: WorkingTreeChange | null,
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
  oldMode: string,
  newMode: string,
): ProvisionalMove {
  return {
    oldPath: slash(oldPath),
    newPath: slash(newPath),
    oldAbsolutePath: path.resolve(root, oldPath),
    newAbsolutePath: path.resolve(root, newPath),
    sourceChange,
    oldContent,
    newContent,
    oldMode,
    newMode,
    reason: "",
    details: [],
  };
}

export function detectRenames(
  root: string,
  changes: WorkingTreeChange[],
  project: ProjectContext,
): { confirmed: ConfirmedMove[]; rejected: Map<WorkingTreeChange, string> } {
  const { deletions, additions, explicitRenames } = sourceEndpoints(changes);
  const provisional: ProvisionalMove[] = [];
  const rejected = new Map<WorkingTreeChange, string>();

  for (const change of explicitRenames) {
    if (
      !change.oldPath ||
      !change.newPath ||
      change.oldContent === undefined ||
      change.newContent === undefined ||
      !change.oldMode ||
      !change.newMode
    ) {
      rejected.set(change, "Git reported a rename, but one side could not be read");
      continue;
    }
    provisional.push(
      makeProvisional(
        root,
        change,
        change.oldPath,
        change.newPath,
        change.oldContent,
        change.newContent,
        change.oldMode,
        change.newMode,
      ),
    );
  }

  const oldByFingerprint = new Map<string, WorkingTreeChange[]>();
  const newByFingerprint = new Map<string, WorkingTreeChange[]>();
  for (const change of deletions) {
    if (!change.oldPath || change.oldContent === undefined) continue;
    const fingerprint = semanticFingerprint(change.oldPath, change.oldContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    oldByFingerprint.set(fingerprint, [...(oldByFingerprint.get(fingerprint) ?? []), change]);
  }
  for (const change of additions) {
    if (!change.newPath || change.newContent === undefined) continue;
    const fingerprint = semanticFingerprint(change.newPath, change.newContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    newByFingerprint.set(fingerprint, [...(newByFingerprint.get(fingerprint) ?? []), change]);
  }
  for (const [fingerprint, oldMatches] of oldByFingerprint) {
    const newMatches = newByFingerprint.get(fingerprint) ?? [];
    if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
    const oldChange = oldMatches[0];
    const newChange = newMatches[0];
    if (
      oldChange?.oldPath &&
      newChange?.newPath &&
      oldChange.oldContent !== undefined &&
      newChange.newContent !== undefined &&
      oldChange.oldMode &&
      newChange.newMode
    ) {
      provisional.push(
        makeProvisional(
          root,
          null,
          oldChange.oldPath,
          newChange.newPath,
          oldChange.oldContent,
          newChange.newContent,
          oldChange.oldMode,
          newChange.newMode,
        ),
      );
    }
  }

  const structurallyMatching = provisional.filter((move) => {
    if (move.oldMode === "120000" || move.newMode === "120000") {
      if (move.sourceChange) {
        rejected.set(move.sourceChange, "Symbolic-link moves are not certified as mechanical");
      }
      return false;
    }
    if (move.oldMode !== move.newMode) {
      if (move.sourceChange) {
        rejected.set(move.sourceChange, "File mode changed during the rename");
      }
      return false;
    }
    if (
      path.extname(move.oldPath).toLowerCase() !==
      path.extname(move.newPath).toLowerCase()
    ) {
      if (move.sourceChange) {
        rejected.set(move.sourceChange, "Source extension changed during the rename");
      }
      return false;
    }
    const oldFingerprint = semanticFingerprint(move.oldPath, move.oldContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    const newFingerprint = semanticFingerprint(move.newPath, move.newContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    if (oldFingerprint !== newFingerprint) {
      if (move.sourceChange) {
        rejected.set(
          move.sourceChange,
          "Git rename candidate was rejected because normalized AST or comments changed",
        );
      }
      return false;
    }
    return true;
  });

  // A Git rename hint does not prove identity when multiple changed files have
  // the same normalized content. Count every changed endpoint, even those Git
  // did not pair, and reject non-unique matches.
  const oldFingerprintCounts = new Map<string, number>();
  const newFingerprintCounts = new Map<string, number>();
  for (const change of [...deletions, ...explicitRenames]) {
    if (!change.oldPath || change.oldContent === undefined) continue;
    const fingerprint = semanticFingerprint(change.oldPath, change.oldContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    oldFingerprintCounts.set(fingerprint, (oldFingerprintCounts.get(fingerprint) ?? 0) + 1);
  }
  for (const change of [...additions, ...explicitRenames]) {
    if (!change.newPath || change.newContent === undefined) continue;
    const fingerprint = semanticFingerprint(change.newPath, change.newContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    newFingerprintCounts.set(fingerprint, (newFingerprintCounts.get(fingerprint) ?? 0) + 1);
  }

  const uniqueCandidates = structurallyMatching.filter((move) => {
    const fingerprint = semanticFingerprint(move.oldPath, move.oldContent, {
      canonicalizeAllModuleSpecifiers: true,
    });
    const unique =
      oldFingerprintCounts.get(fingerprint) === 1 &&
      newFingerprintCounts.get(fingerprint) === 1;
    if (!unique && move.sourceChange) {
      rejected.set(
        move.sourceChange,
        "Normalized content has multiple changed predecessors or successors",
      );
    }
    return unique;
  });

  interface ValidatingMove {
    move: ProvisionalMove;
    oldReferences: ReturnType<typeof extractStaticModuleReferences>;
    newReferences: ReturnType<typeof extractStaticModuleReferences>;
  }

  const prevalidated: ValidatingMove[] = [];
  for (const move of uniqueCandidates) {
    const hazards = [
      ...findPathSensitiveConstructs(move.oldPath, move.oldContent),
      ...findPathSensitiveConstructs(move.newPath, move.newContent),
    ];
    if (hazards.length > 0) {
      if (move.sourceChange) {
        rejected.set(
          move.sourceChange,
          `Path-sensitive construct prevents move proof: ${[...new Set(hazards)].join(", ")}`,
        );
      }
      continue;
    }

    const oldReferences = extractStaticModuleReferences(move.oldPath, move.oldContent);
    const newReferences = extractStaticModuleReferences(move.newPath, move.newContent);
    let failure: string | null = null;
    if (oldReferences.length !== newReferences.length) {
      failure = "Static module reference count changed";
    } else if (!failure) {
      for (let index = 0; index < oldReferences.length; index += 1) {
        const oldReference = oldReferences[index]!;
        const newReference = newReferences[index]!;
        if (
          oldReference.kind !== newReference.kind ||
          oldReference.structuralKey !== newReference.structuralKey
        ) {
          failure = "Import/export structure changed during the move";
          break;
        }
        if (oldReference.sideEffectOnly || newReference.sideEffectOnly) {
          failure = "Side-effect-only imports are not certified as mechanical";
          break;
        }
      }
    }

    if (failure) {
      if (move.sourceChange) rejected.set(move.sourceChange, failure);
      continue;
    }
    prevalidated.push({ move, oldReferences, newReferences });
  }

  // Resolve dependency evidence to a fixed point. If candidate X only resolves
  // through candidate Y and Y is rejected, X is rejected on the next pass too.
  let active = [...prevalidated];
  let changed = true;
  while (changed) {
    changed = false;
    const activeMoves = active.map(({ move }) => move);
    const next: ValidatingMove[] = [];
    for (const candidate of active) {
      let failure: string | null = null;
      for (let index = 0; index < candidate.oldReferences.length; index += 1) {
        const oldReference = candidate.oldReferences[index]!;
        const newReference = candidate.newReferences[index]!;
        const resolution = compareResolutions(
          project,
          oldReference.specifier,
          candidate.move.oldAbsolutePath,
          newReference.specifier,
          candidate.move.newAbsolutePath,
          activeMoves,
        );
        if (!resolution.equivalent) {
          failure = `Module reference ${JSON.stringify(oldReference.specifier)} → ${JSON.stringify(newReference.specifier)} did not resolve to the same proven module identity`;
          break;
        }
      }
      if (failure) {
        changed = true;
        if (candidate.move.sourceChange) rejected.set(candidate.move.sourceChange, failure);
      } else {
        next.push(candidate);
      }
    }
    active = next;
  }

  const activeMoves = active.map(({ move }) => move);
  const confirmed: ConfirmedMove[] = active.map((candidate) => {
    const resolutionDetails = candidate.oldReferences.map((oldReference, index) => {
      const newReference = candidate.newReferences[index]!;
      const resolution = compareResolutions(
        project,
        oldReference.specifier,
        candidate.move.oldAbsolutePath,
        newReference.specifier,
        candidate.move.newAbsolutePath,
        activeMoves,
      );
      return `${oldReference.specifier} (${displayTarget(root, resolution.oldTarget)}) → ${newReference.specifier} (${displayTarget(root, resolution.newTarget)})`;
    });
    return {
      oldPath: candidate.move.oldPath,
      newPath: candidate.move.newPath,
      oldAbsolutePath: candidate.move.oldAbsolutePath,
      newAbsolutePath: candidate.move.newAbsolutePath,
      sourceChange: candidate.move.sourceChange,
      reason: "Normalized AST and comments are identical after module-path canonicalization",
      details: [
        "Every static import/export resolves to the same module identity across snapshots",
        ...resolutionDetails,
      ],
    };
  });

  return { confirmed, rejected };
}
