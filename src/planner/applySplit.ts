import { runGit } from "../git/runGit.js";
import { assertCleanIndex } from "../git/temporaryIndex.js";
import { buildSplitPlan } from "./buildSplitPlan.js";
import { stageSplitPart } from "./stageSplitPart.js";
import type { SplitPlan } from "./types.js";

export const DEFAULT_COMMIT_MESSAGE_A = "Apply behavioral changes";
export const DEFAULT_COMMIT_MESSAGE_B = "Apply mechanical structural refactor";

export interface ResolvedCommitMessages {
  a: string;
  b: string;
}

export interface AppliedCommit {
  committed: boolean;
  message: string;
  commitId?: string;
}

export interface ApplySplitResult {
  initialBaseCommit: string;
  finalCommit: string;
  a: AppliedCommit;
  b: AppliedCommit;
}

export function resolveCommitMessages(messages: string[]): ResolvedCommitMessages {
  if (messages.length > 2) {
    throw new Error("apply accepts at most two commit messages: A then B");
  }
  if (messages.some((message) => message.trim().length === 0)) {
    throw new Error("Commit messages cannot be empty");
  }
  return {
    a: messages[0] ?? DEFAULT_COMMIT_MESSAGE_A,
    b: messages[1] ?? DEFAULT_COMMIT_MESSAGE_B,
  };
}

function headCommit(root: string): string {
  return runGit(root, ["rev-parse", "HEAD"]).trim();
}

function headTree(root: string): string {
  return runGit(root, ["rev-parse", "HEAD^{tree}"]).trim();
}

function commit(root: string, message: string): string {
  runGit(root, ["commit", "-m", message]);
  return headCommit(root);
}

function skipped(message: string): AppliedCommit {
  return { committed: false, message };
}

export function applySplit(
  initialPlan: SplitPlan,
  messageArguments: string[] = [],
): ApplySplitResult {
  const messages = resolveCommitMessages(messageArguments);
  const { root } = initialPlan;
  assertCleanIndex(root);
  const initialFinalTree = initialPlan.b.treeId;
  let resultA = skipped(messages.a);
  let resultB = skipped(messages.b);
  let planForB = initialPlan;

  if (initialPlan.a.patch.length > 0) {
    stageSplitPart(initialPlan, "a");
    const commitId = commit(root, messages.a);
    if (headTree(root) !== initialPlan.a.treeId) {
      throw new Error(
        "Commit A tree differs from the verified plan, possibly because a Git hook modified it; B was not attempted",
      );
    }
    resultA = { committed: true, message: messages.a, commitId };
    planForB = buildSplitPlan(root, {
      ...(initialPlan.report.aiReview
        ? { reuseReview: initialPlan.report.aiReview }
        : {}),
    });
    if (planForB.b.treeId !== initialFinalTree) {
      throw new Error(
        "Working tree changed after commit A; B was not attempted. Review the A commit and current working tree",
      );
    }
  }

  if (planForB.b.patch.length > 0) {
    stageSplitPart(planForB, "b");
    const commitId = commit(root, messages.b);
    if (headTree(root) !== planForB.b.treeId) {
      throw new Error(
        "Commit B tree differs from the verified plan, possibly because a Git hook modified it",
      );
    }
    resultB = { committed: true, message: messages.b, commitId };
  }

  return {
    initialBaseCommit: initialPlan.baseCommit,
    finalCommit: headCommit(root),
    a: resultA,
    b: resultB,
  };
}
