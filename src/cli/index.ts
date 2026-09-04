#!/usr/bin/env node
import { analyzeRepository } from "../classifier/classify.js";
import { buildSplitPlan } from "../planner/buildSplitPlan.js";
import { applySplit, resolveCommitMessages } from "../planner/applySplit.js";
import { stageSplitPart } from "../planner/stageSplitPart.js";
import { writeSplitArtifacts } from "../planner/writeSplitArtifacts.js";
import type {
  AmbiguousReviewerOptions,
  AmbiguousReviewerProvider,
} from "../reviewer/aiReviewer.js";
import { ambiguousClassificationId } from "../reviewer/aiReviewer.js";
import type { AnalysisReport } from "../types.js";
import {
  formatApplyDryRun,
  formatApplyResult,
  formatDryRun,
  formatReport,
  formatWrittenPlan,
} from "./report.js";

interface ParsedArguments {
  command: "report" | "split" | "stage-a" | "stage-b" | "apply" | "help";
  cwd: string;
  verbose: boolean;
  json: boolean;
  dryRun: boolean;
  outputDirectory?: string;
  review?: AmbiguousReviewerProvider;
  model?: string;
  effort?: string;
  adapter?: string;
  file?: string;
  commitMessages: string[];
}

function usage(): string {
  return `split-commit — conservative semantic Git change classifier

Usage:
  split-commit report [--verbose] [--json] [--review <provider>] [--cwd <path>]
  split-commit split [--dry-run] [--output-dir <path>] [--review <provider>] [--cwd <path>]
  split-commit stage-a [--dry-run] [--review <provider>] [--cwd <path>]
  split-commit stage-b [--dry-run] [--review <provider>] [--cwd <path>]
  split-commit apply ["message A"] ["message B"] [--dry-run] [--review <provider>] [--cwd <path>]

AI review:
  --review codex|claude|command|file
  --model <model>       Model override for Codex or Claude Code
  --effort <level>      Reasoning effort override for Codex or Claude Code
  --command <path>      Executable JSON adapter used with --review command
  --file <path>         Structured decisions produced by the Desktop skill

Policy:
  B  deterministic mechanical changes plus AI-reviewed ambiguous changes assigned to B
  A  behavioral changes plus ambiguous changes assigned to A
  AI-reviewed ambiguous changes follow the reviewer's A/B decision

Safety:
  split writes patch artifacts but never modifies the index
  stage-a/stage-b require an index that is clean relative to HEAD
  apply commits A first, reanalyzes, then commits B
  without --review, ambiguous changes are included in A`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const commandValue = argv[0];
  const command = ["report", "split", "stage-a", "stage-b", "apply"].includes(
    commandValue ?? "",
  )
    ? (commandValue as ParsedArguments["command"])
    : "help";
  let cwd = process.cwd();
  let verbose = false;
  let json = false;
  let dryRun = false;
  let outputDirectory: string | undefined;
  let review: AmbiguousReviewerProvider | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let adapter: string | undefined;
  let file: string | undefined;
  const commitMessages: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--" && command === "apply") {
      commitMessages.push(...argv.slice(index + 1));
      break;
    } else if (argument === "--verbose" || argument === "-v") verbose = true;
    else if (argument === "--json") json = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--review") {
      const value = argv[index + 1];
      if (
        value !== "codex" &&
        value !== "claude" &&
        value !== "command" &&
        value !== "file"
      ) {
        throw new Error("--review requires codex, claude, command, or file");
      }
      review = value;
      index += 1;
    } else if (argument === "--model") {
      const value = argv[index + 1];
      if (!value) throw new Error("--model requires a model name");
      model = value;
      index += 1;
    } else if (argument === "--effort") {
      const value = argv[index + 1];
      if (!value) throw new Error("--effort requires a level");
      effort = value;
      index += 1;
    } else if (argument === "--command") {
      const value = argv[index + 1];
      if (!value) throw new Error("--command requires an executable path");
      adapter = value;
      index += 1;
    } else if (argument === "--file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--file requires a path");
      file = value;
      index += 1;
    } else if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir requires a path");
      outputDirectory = value;
      index += 1;
    } else if (argument === "--cwd") {
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
        commitMessages,
        ...(outputDirectory ? { outputDirectory } : {}),
        ...(review ? { review } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(adapter ? { adapter } : {}),
        ...(file ? { file } : {}),
      };
    } else if (command === "apply") {
      commitMessages.push(argument!);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if ((model || effort) && !review) {
    throw new Error("--model and --effort require --review");
  }
  if ((model || effort) && review !== "codex" && review !== "claude") {
    throw new Error(
      "--model and --effort are only valid with --review codex or claude",
    );
  }
  if (adapter && review !== "command") {
    throw new Error("--command is only valid with --review command");
  }
  if (review === "command" && !adapter) {
    throw new Error("--command is required with --review command");
  }
  if (file && review !== "file") {
    throw new Error("--file is only valid with --review file");
  }
  if (review === "file" && !file) {
    throw new Error("--file is required with --review file");
  }
  return {
    command,
    cwd,
    verbose,
    json,
    dryRun,
    commitMessages,
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(review ? { review } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(adapter ? { adapter } : {}),
    ...(file ? { file } : {}),
  };
}

function reviewOptions(args: ParsedArguments): AmbiguousReviewerOptions | undefined {
  if (!args.review) return undefined;
  return {
    provider: args.review,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.adapter ? { command: args.adapter } : {}),
    ...(args.file ? { file: args.file } : {}),
  };
}

function serializableReport(report: AnalysisReport): object {
  return {
    ...report,
    ambiguous: report.ambiguous.map((item) => ({
      ...item,
      classificationId: ambiguousClassificationId(item),
    })),
  };
}

function serializablePlan(plan: ReturnType<typeof buildSplitPlan>): object {
  return {
    root: plan.root,
    baseCommit: plan.baseCommit,
    report: serializableReport(plan.report),
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
    const reviewer = reviewOptions(args);
    const report = reviewer
      ? buildSplitPlan(args.cwd, { reviewer }).report
      : analyzeRepository(args.cwd);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(serializableReport(report), null, 2)}\n`);
    }
    else process.stdout.write(`${formatReport(report, args.verbose)}\n`);
    return;
  }

  const reviewer = reviewOptions(args);
  const plan = buildSplitPlan(args.cwd, {
    ...(reviewer ? { reviewer } : {}),
  });
  if (args.dryRun) {
    if (args.command === "apply") {
      const messages = resolveCommitMessages(args.commitMessages);
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ...serializablePlan(plan), commitMessages: messages }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${formatApplyDryRun(plan, messages, args.verbose)}\n`);
      }
    } else if (args.json) {
      process.stdout.write(`${JSON.stringify(serializablePlan(plan), null, 2)}\n`);
    } else {
      process.stdout.write(`${formatDryRun(plan, args.verbose)}\n`);
    }
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

  if (args.command === "apply") {
    const result = applySplit(plan, args.commitMessages);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${formatApplyResult(result)}\n`);
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
  process.stderr.write(`split-commit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
