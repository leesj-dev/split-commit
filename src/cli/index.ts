#!/usr/bin/env node
import { analyzeRepository } from "../classifier/classify.js";
import { formatDryRun, formatReport } from "./report.js";

interface ParsedArguments {
  command: "report" | "split" | "help";
  cwd: string;
  verbose: boolean;
  json: boolean;
  dryRun: boolean;
}

function usage(): string {
  return `semantic-split — conservative semantic Git change classifier

Usage:
  semantic-split report [--verbose] [--json] [--cwd <path>]
  semantic-split split --dry-run [--verbose] [--json] [--cwd <path>]

Policy:
  B  only changes with high-confidence mechanical evidence
  A  behavioral changes plus every ambiguous change

Phase 1 implements analysis and dry-run planning. It never modifies the index.`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const commandValue = argv[0];
  const command =
    commandValue === "report" || commandValue === "split" ? commandValue : "help";
  let cwd = process.cwd();
  let verbose = false;
  let json = false;
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verbose" || argument === "-v") verbose = true;
    else if (argument === "--json") json = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--cwd") {
      const value = argv[index + 1];
      if (!value) throw new Error("--cwd requires a path");
      cwd = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { command: "help", cwd, verbose, json, dryRun };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { command, cwd, verbose, json, dryRun };
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.command === "split" && !args.dryRun) {
    throw new Error(
      "Phase 1 does not mutate the Git index. Use `semantic-split split --dry-run`.",
    );
  }
  const report = analyzeRepository(args.cwd);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.command === "split") {
    process.stdout.write(`${formatDryRun(report, args.verbose)}\n`);
  } else {
    process.stdout.write(`${formatReport(report, args.verbose)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`semantic-split: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
