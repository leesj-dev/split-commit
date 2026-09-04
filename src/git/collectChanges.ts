import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkingTreeChange } from "../types.js";
import { runGit, tryGit } from "./runGit.js";

function parseNameStatus(output: string): WorkingTreeChange[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const changes: WorkingTreeChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const statusField = fields[index++];
    if (!statusField) continue;
    const code = statusField[0];

    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) throw new Error("Malformed Git rename record");
      const similarity = Number.parseInt(statusField.slice(1), 10);
      changes.push({
        status: "renamed",
        oldPath,
        newPath,
        ...(Number.isNaN(similarity) ? {} : { gitSimilarity: similarity }),
      });
      continue;
    }

    const filePath = fields[index++];
    if (!filePath) throw new Error("Malformed Git name-status record");
    if (code === "M" || code === "T" || code === "U") {
      changes.push({ status: "modified", oldPath: filePath, newPath: filePath });
    } else if (code === "A") {
      changes.push({ status: "added", newPath: filePath });
    } else if (code === "D") {
      changes.push({ status: "deleted", oldPath: filePath });
    }
  }
  return changes;
}

function readHeadFile(root: string, filePath: string): string {
  return runGit(root, ["show", `HEAD:${filePath}`]);
}

function readWorkingFile(root: string, filePath: string): string | undefined {
  const absolutePath = path.join(root, filePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
}

export interface CollectedChanges {
  root: string;
  changes: WorkingTreeChange[];
}

export function collectChanges(cwd = process.cwd()): CollectedChanges {
  const rootOutput = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootOutput) throw new Error(`Not a Git repository: ${cwd}`);
  const root = path.resolve(rootOutput.trim());

  if (!tryGit(root, ["rev-parse", "--verify", "HEAD"])) {
    throw new Error("semantic-split needs an initial commit to compare against");
  }

  const diff = runGit(root, [
    "diff",
    "HEAD",
    "--name-status",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    "--",
  ]);
  const changes = parseNameStatus(diff);

  const untrackedOutput = runGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  for (const filePath of untracked) {
    changes.push({ status: "added", newPath: filePath, untracked: true });
  }

  // A staged deletion followed by an untracked recreation at the same path is
  // one working-tree modification, not a delete/add pair.
  for (const deletion of [...changes]) {
    if (deletion.status !== "deleted" || !deletion.oldPath) continue;
    const addition = changes.find(
      (item) => item.status === "added" && item.newPath === deletion.oldPath,
    );
    if (!addition) continue;
    const deletionIndex = changes.indexOf(deletion);
    const additionIndex = changes.indexOf(addition);
    changes.splice(Math.max(deletionIndex, additionIndex), 1);
    changes.splice(Math.min(deletionIndex, additionIndex), 1);
    changes.push({
      status: "modified",
      oldPath: deletion.oldPath,
      newPath: deletion.oldPath,
      untracked: true,
    });
  }

  for (const change of changes) {
    if (change.oldPath) change.oldContent = readHeadFile(root, change.oldPath);
    if (change.newPath) {
      const content = readWorkingFile(root, change.newPath);
      if (content !== undefined) change.newContent = content;
    }
  }

  changes.sort((left, right) =>
    (left.newPath ?? left.oldPath ?? "").localeCompare(
      right.newPath ?? right.oldPath ?? "",
    ),
  );
  return { root, changes };
}
