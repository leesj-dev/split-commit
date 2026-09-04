import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SetIndexOperation {
  kind: "set";
  path: string;
  mode: string;
  content: Buffer;
}

export interface RemoveIndexOperation {
  kind: "remove";
  path: string;
}

export type IndexOperation = SetIndexOperation | RemoveIndexOperation;

export interface BuiltPatch {
  patch: Buffer;
  treeId: string;
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

const GIT_COMMAND_TIMEOUT_MS = 60_000;

function gitBuffer(root: string, args: string[], options: GitOptions = {}): Buffer {
  let inputDirectory: string | undefined;
  let inputDescriptor: number | undefined;
  try {
    if (options.input !== undefined) {
      inputDirectory = mkdtempSync(path.join(tmpdir(), "split-commit-stdin-"));
      const inputPath = path.join(inputDirectory, "input");
      writeFileSync(inputPath, options.input, { mode: 0o600 });
      inputDescriptor = openSync(inputPath, "r");
    }

    return execFileSync("git", args, {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: [inputDescriptor ?? "ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? Buffer.from(error.stderr as Uint8Array).toString("utf8")
        : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  } finally {
    if (inputDescriptor !== undefined) closeSync(inputDescriptor);
    if (inputDirectory) rmSync(inputDirectory, { recursive: true, force: true });
  }
}

function temporaryIndexEnvironment(
  root: string,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const commonDirectoryValue = gitBuffer(root, ["rev-parse", "--git-common-dir"])
    .toString("utf8")
    .trim();
  const commonDirectory = path.resolve(root, commonDirectoryValue);
  const realObjectDirectory = path.join(commonDirectory, "objects");
  const temporaryObjectDirectory = path.join(temporaryDirectory, "objects");
  mkdirSync(temporaryObjectDirectory, { recursive: true });
  const alternates = [
    realObjectDirectory,
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  ].filter((value): value is string => Boolean(value));
  return {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporaryDirectory, "index"),
    GIT_OBJECT_DIRECTORY: temporaryObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(path.delimiter),
  };
}

export function readWorkingTreeEntry(
  root: string,
  filePath: string,
): { mode: string; content: Buffer } {
  const absolutePath = path.join(root, filePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { mode: "120000", content: Buffer.from(readlinkSync(absolutePath)) };
  }
  if (!stat.isFile()) throw new Error(`Cannot stage non-file path: ${filePath}`);
  return {
    mode: stat.mode & 0o111 ? "100755" : "100644",
    content: readFileSync(absolutePath),
  };
}

function buildTreeFromOperations(
  root: string,
  operations: IndexOperation[],
  env: NodeJS.ProcessEnv,
): string {
  gitBuffer(root, ["read-tree", "HEAD"], { env });
  const removals = new Set(
    operations.filter((operation) => operation.kind === "remove").map(({ path }) => path),
  );
  const additions = new Map(
    operations
      .filter((operation): operation is SetIndexOperation => operation.kind === "set")
      .map((operation) => [operation.path, operation]),
  );

  for (const filePath of removals) {
    gitBuffer(root, ["update-index", "--force-remove", "--", filePath], { env });
  }
  for (const operation of additions.values()) {
    const hashArguments =
      operation.mode === "120000"
        ? ["hash-object", "-w", "--stdin"]
        : ["hash-object", "-w", "--path", operation.path, "--stdin"];
    const objectId = gitBuffer(root, hashArguments, {
      env,
      input: operation.content,
    })
      .toString("utf8")
      .trim();
    gitBuffer(
      root,
      ["update-index", "--add", "--cacheinfo", operation.mode, objectId, operation.path],
      { env },
    );
  }
  return gitBuffer(root, ["write-tree"], { env }).toString("utf8").trim();
}

function diffTrees(
  root: string,
  fromTreeId: string,
  toTreeId: string,
  env: NodeJS.ProcessEnv,
): Buffer {
  return gitBuffer(
    root,
    [
      "diff",
      "--binary",
      "--full-index",
      "--find-renames",
      "--no-color",
      fromTreeId,
      toTreeId,
      "--",
    ],
    { env },
  );
}

export function buildSequentialPatches(
  root: string,
  operationsA: IndexOperation[],
  finalOperations: IndexOperation[],
): { a: BuiltPatch; b: BuiltPatch } {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "split-commit-index-"));
  const env = temporaryIndexEnvironment(root, temporaryDirectory);
  try {
    const baseTreeId = gitBuffer(root, ["rev-parse", "HEAD^{tree}"], { env })
      .toString("utf8")
      .trim();
    const treeA = buildTreeFromOperations(root, operationsA, env);
    const finalTree = buildTreeFromOperations(root, finalOperations, env);
    return {
      a: { patch: diffTrees(root, baseTreeId, treeA, env), treeId: treeA },
      b: { patch: diffTrees(root, treeA, finalTree, env), treeId: finalTree },
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function currentHead(root: string): string {
  return gitBuffer(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
}

function currentIndexIsClean(root: string): boolean {
  const result = spawnSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], {
    cwd: root,
    stdio: "pipe",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Could not inspect Git index: ${result.stderr.toString().trim()}`);
}

export function assertCleanIndex(root: string): void {
  if (!currentIndexIsClean(root)) {
    throw new Error(
      "Git index already contains staged changes; commit or unstage them before split-commit staging",
    );
  }
}

export function stageBuiltPatch(
  root: string,
  baseCommit: string,
  built: BuiltPatch,
): void {
  if (currentHead(root) !== baseCommit) {
    throw new Error("HEAD changed after analysis; rerun split-commit");
  }
  assertCleanIndex(root);
  if (built.patch.length === 0) return;

  gitBuffer(root, ["apply", "--cached", "--check", "--binary", "-"], {
    input: built.patch,
  });
  gitBuffer(root, ["apply", "--cached", "--binary", "-"], { input: built.patch });
  const actualTree = gitBuffer(root, ["write-tree"]).toString("utf8").trim();
  if (actualTree !== built.treeId) {
    // The command started from a clean index, so HEAD is the exact safe restore point.
    gitBuffer(root, ["read-tree", "HEAD"]);
    throw new Error("Staged tree verification failed; the original clean index was restored");
  }
}
