import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SplitManifest, SplitPlan } from "./types.js";

function atomicWrite(filePath: string, content: string | Buffer): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, filePath);
}

export interface WrittenArtifacts {
  outputDirectory: string;
  manifestPath: string;
  patchAPath: string;
  patchBPath: string;
  reportPath: string;
}

export function writeSplitArtifacts(
  plan: SplitPlan,
  requestedOutputDirectory?: string,
): WrittenArtifacts {
  const outputDirectory = requestedOutputDirectory
    ? path.resolve(plan.root, requestedOutputDirectory)
    : path.join(plan.root, ".split-commit");
  mkdirSync(outputDirectory, { recursive: true });

  const patchAPath = path.join(outputDirectory, "commit-a.patch");
  const patchBPath = path.join(outputDirectory, "commit-b.patch");
  const reportPath = path.join(outputDirectory, "report.json");
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest: SplitManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repository: plan.root,
    baseCommit: plan.baseCommit,
    policy: { ambiguousDestination: "A", order: ["A", "B"] },
    patches: {
      a: { ...plan.a.metadata, file: "commit-a.patch" },
      b: { ...plan.b.metadata, file: "commit-b.patch" },
    },
  };

  atomicWrite(patchAPath, plan.a.patch);
  atomicWrite(patchBPath, plan.b.patch);
  atomicWrite(reportPath, `${JSON.stringify(plan.report, null, 2)}\n`);
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDirectory, manifestPath, patchAPath, patchBPath, reportPath };
}
