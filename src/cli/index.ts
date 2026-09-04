#!/usr/bin/env node
import { analyzeRepository } from "../classifier/classify.js";
import { buildSplitPlan } from "../planner/buildSplitPlan.js";
import { stageSplitPart } from "../planner/stageSplitPart.js";
import { writeSplitArtifacts } from "../planner/writeSplitArtifacts.js";
import { formatDryRun, formatReport, formatWrittenPlan } from "./report.js";

interface ParsedArguments {
  command: "report" | "split" | "stage-a" | "stage-b" | "help";
  cwd: string;
  verbose: boolean;
  json: boolean;
  dryRun: boolean;
  outputDirectory?: string;
}

function usage(): string {
  return `semantic-split — conservative semantic Git change classifier

Usage:
  semantic-split report [--verbose] [--json] [--cwd <path>]
  semantic-split split [--dry-run] [--output-dir <path>] [--cwd <path>]
  semantic-split stage-a [--dry-run] [--cwd <path>]
  semantic-split stage-b [--dry-run] [--cwd <path>]

Policy:
  B  only changes with high-confidence mechanical evidence
  A  behavioral changes plus every ambiguous change

Safety:
  split writes patch artifacts but never modifies the index
  stage-a/stage-b require an index that is clean relative to HEAD
  ambiguous changes are always included in A`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const commandValue = argv[0];
  const command = ["report", "split", "stage-a", "stage-b"].includes(
    commandValue ?? "",
  )
    ? (commandValue as ParsedArguments["command"])
    : "help";
  let cwd = process.cwd();
  let verbose = false;
  let json = false;
  let dryRun = false;
  let outputDirectory: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verbose" || argument === "-v") verbose = true;
    else if (argument === "--json") json = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir requires a path");
      outputDirectory = value;
      index += 1;
    }
    else if (argument === "--cwd") {
      const value = argv[index + 1];
      if (!value) throw new Error("--cwd requires a path");
      cwd = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return {
        command: "help",
        cwd,
        verbose,
        json,
        dryRun,
        ...(outputDirectory ? { outputDirectory } : {}),
      };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return {
    command,
    cwd,
    verbose,
    json,
    dryRun,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

function serializablePlan(plan: ReturnType<typeof buildSplitPlan>): object {
  return {
    root: plan.root,
    baseCommit: plan.baseCommit,
    report: plan.report,
    patches: { a: plan.a.metadata, b: plan.b.metadata },
  };
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.outputDirectory && args.command !== "split") {
    throw new Error("--output-dir is only valid with the split command");
  }
  if (args.command === "report") {
    const report = analyzeRepository(args.cwd);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatReport(report, args.verbose)}\n`);
    return;
  }

  const plan = buildSplitPlan(args.cwd);
  if (args.dryRun) {
    if (args.json) process.stdout.write(`${JSON.stringify(serializablePlan(plan), null, 2)}\n`);
    else process.stdout.write(`${formatDryRun(plan, args.verbose)}\n`);
    return;
  }

  if (args.command === "split") {
    const written = writeSplitArtifacts(plan, args.outputDirectory);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ...serializablePlan(plan), artifacts: written }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `${formatWrittenPlan(plan, written.outputDirectory, args.verbose)}\n`,
      );
    }
    return;
  }

  const part = args.command === "stage-a" ? "a" : "b";
  stageSplitPart(plan, part);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ staged: part.toUpperCase(), patch: plan[part].metadata }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${formatReport(plan.report, args.verbose)}\n`);
    process.stdout.write(
      `\nStaged commit ${part.toUpperCase()}: ${plan[part].metadata.files} files. Working tree was preserved.\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`semantic-split: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
