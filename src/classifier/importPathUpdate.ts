import path from "node:path";
import type {
  Classification,
  ConfirmedMove,
  WorkingTreeChange,
} from "../types.js";
import {
  extractStaticModuleReferences,
  semanticFingerprint,
  type StaticModuleReference,
} from "../ts/astNormalizer.js";
import { compareResolutions, displayTarget } from "../ts/moduleResolver.js";
import type { ProjectContext } from "../ts/projectLoader.js";

interface PairedReference {
  oldReference: StaticModuleReference;
  newReference: StaticModuleReference;
}

export interface ModuleUpdateAnalysis {
  mechanical: Classification[];
  ambiguous: Classification[];
  oldReplacements: Map<number, string>;
  newReplacements: Map<number, string>;
  allPairedOldReplacements: Map<number, string>;
  allPairedNewReplacements: Map<number, string>;
}

function pairChangedReferences(
  oldReferences: StaticModuleReference[],
  newReferences: StaticModuleReference[],
): PairedReference[] {
  const oldGroups = new Map<string, StaticModuleReference[]>();
  const newGroups = new Map<string, StaticModuleReference[]>();
  for (const reference of oldReferences) {
    const key = `${reference.kind}\u0000${reference.structuralKey}`;
    oldGroups.set(key, [...(oldGroups.get(key) ?? []), reference]);
  }
  for (const reference of newReferences) {
    const key = `${reference.kind}\u0000${reference.structuralKey}`;
    newGroups.set(key, [...(newGroups.get(key) ?? []), reference]);
  }

  const pairs: PairedReference[] = [];
  for (const [key, oldMatches] of oldGroups) {
    const newMatches = newGroups.get(key) ?? [];
    if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
    const oldReference = oldMatches[0]!;
    const newReference = newMatches[0]!;
    if (oldReference.specifier !== newReference.specifier) {
      pairs.push({ oldReference, newReference });
    }
  }
  return pairs;
}

function classificationKind(
  filePath: string,
  reference: StaticModuleReference,
): "import-path-update" | "export-path-update" | "barrel-update" {
  if (reference.kind === "import") return "import-path-update";
  if (/^index\.[cm]?[jt]sx?$/.test(path.basename(filePath))) return "barrel-update";
  return "export-path-update";
}

export function analyzeModuleUpdates(
  root: string,
  change: WorkingTreeChange,
  project: ProjectContext,
  moves: ConfirmedMove[],
): ModuleUpdateAnalysis {
  const filePath = change.newPath ?? change.oldPath!;
  const oldContent = change.oldContent ?? "";
  const newContent = change.newContent ?? "";
  const oldReferences = extractStaticModuleReferences(filePath, oldContent);
  const newReferences = extractStaticModuleReferences(filePath, newContent);
  const pairs = pairChangedReferences(oldReferences, newReferences);
  const mechanical: Classification[] = [];
  const ambiguous: Classification[] = [];
  const oldReplacements = new Map<number, string>();
  const newReplacements = new Map<number, string>();
  const allPairedOldReplacements = new Map<number, string>();
  const allPairedNewReplacements = new Map<number, string>();

  pairs.forEach(({ oldReference, newReference }, index) => {
    const marker = `<paired-module-${index}>`;
    allPairedOldReplacements.set(oldReference.specifierStart, marker);
    allPairedNewReplacements.set(newReference.specifierStart, marker);

    const displayPath = filePath.split(path.sep).join("/");
    if (project.configChanged) {
      ambiguous.push({
        side: "ambiguous",
        kind: "unresolved-module-update",
        path: displayPath,
        line: newReference.line,
        reason: "tsconfig.json changed, so Phase 1 will not certify module identity",
        details: [
          `${JSON.stringify(oldReference.specifier)} → ${JSON.stringify(newReference.specifier)}`,
          "Ambiguous changes are assigned to commit A by default",
        ],
        confidence: "none",
      });
      return;
    }

    if (oldReference.sideEffectOnly || newReference.sideEffectOnly) {
      ambiguous.push({
        side: "ambiguous",
        kind: "unsafe-module-update",
        path: displayPath,
        line: newReference.line,
        reason: "Side-effect-only import updates are not certified as mechanical",
        details: [
          `${JSON.stringify(oldReference.specifier)} → ${JSON.stringify(newReference.specifier)}`,
          "Module initialization ordering can be observable",
          "Ambiguous changes are assigned to commit A by default",
        ],
        confidence: "none",
      });
      return;
    }

    const containingFile = path.resolve(root, filePath);
    const resolution = compareResolutions(
      project,
      oldReference.specifier,
      containingFile,
      newReference.specifier,
      containingFile,
      moves,
    );
    if (!resolution.equivalent) {
      ambiguous.push({
        side: "ambiguous",
        kind: "unresolved-module-update",
        path: displayPath,
        line: newReference.line,
        reason: "Old and new module specifiers do not resolve to a proven-identical target",
        details: [
          `old ${JSON.stringify(oldReference.specifier)} → ${displayTarget(root, resolution.oldTarget)}`,
          `new ${JSON.stringify(newReference.specifier)} → ${displayTarget(root, resolution.newTarget)}`,
          "Ambiguous changes are assigned to commit A by default",
        ],
        confidence: "none",
      });
      return;
    }

    oldReplacements.set(oldReference.specifierStart, marker);
    newReplacements.set(newReference.specifierStart, marker);
    mechanical.push({
      side: "mechanical",
      kind: classificationKind(filePath, newReference),
      path: displayPath,
      line: newReference.line,
      reason: "Both specifiers resolve to the same module identity or a proven file move",
      details: [
        `old ${JSON.stringify(oldReference.specifier)} → ${displayTarget(root, resolution.oldTarget)}`,
        `new ${JSON.stringify(newReference.specifier)} → ${displayTarget(root, resolution.newTarget)}`,
      ],
      confidence: "high",
    });
  });

  return {
    mechanical,
    ambiguous,
    oldReplacements,
    newReplacements,
    allPairedOldReplacements,
    allPairedNewReplacements,
  };
}

export function hasBehavioralRemainder(
  filePath: string,
  oldContent: string,
  newContent: string,
  analysis: ModuleUpdateAnalysis,
): boolean {
  const oldFingerprint = semanticFingerprint(filePath, oldContent, {
    moduleReplacements: analysis.allPairedOldReplacements,
  });
  const newFingerprint = semanticFingerprint(filePath, newContent, {
    moduleReplacements: analysis.allPairedNewReplacements,
  });
  return oldFingerprint !== newFingerprint;
}

export function hasAnyAstChange(
  filePath: string,
  oldContent: string,
  newContent: string,
): boolean {
  return semanticFingerprint(filePath, oldContent) !== semanticFingerprint(filePath, newContent);
}
