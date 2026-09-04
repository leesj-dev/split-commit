import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSplitPlan } from "../src/planner/buildSplitPlan.js";
import { stageSplitPart } from "../src/planner/stageSplitPart.js";

const repositories: string[] = [];

after(() => {
  for (const repository of repositories) rmSync(repository, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function move(root: string, oldPath: string, newPath: string): void {
  mkdirSync(path.dirname(path.join(root, newPath)), { recursive: true });
  renameSync(path.join(root, oldPath), path.join(root, newPath));
}

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-split-phase2-"));
  repositories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "semantic-split test");
  write(
    root,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  for (const [filePath, content] of Object.entries(files)) write(root, filePath, content);
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture baseline");
  return root;
}

test("mixed changes produce commit A first and a verified mechanical commit B second", () => {
  const root = repository({
    "src/lib/cache.ts": "export const cache: Record<string, number> = {};\n",
    "src/read.ts": [
      'import { cache } from "./lib/cache";',
      "export const read = (id: string) => cache[id];",
      "",
    ].join("\n"),
  });
  move(root, "src/lib/cache.ts", "src/state/cache.ts");
  write(
    root,
    "src/read.ts",
    [
      'import { cache } from "./state/cache";',
      "export const read = async (id: string) => await Promise.resolve(cache[id]);",
      "",
    ].join("\n"),
  );

  const firstPlan = buildSplitPlan(root);
  const patchA = firstPlan.a.patch.toString("utf8");
  const patchB = firstPlan.b.patch.toString("utf8");
  assert.match(patchA, /Promise\.resolve/);
  assert.doesNotMatch(patchA, /state\/cache/);
  assert.match(patchB, /state\/cache/);
  assert.doesNotMatch(patchB, /^[+-].*Promise\.resolve/m);
  assert.throws(
    () => stageSplitPart(firstPlan, "b"),
    /Commit A candidates remain/,
  );

  stageSplitPart(firstPlan, "a");
  const stagedA = git(root, "show", ":src/read.ts");
  assert.match(stagedA, /lib\/cache/);
  assert.match(stagedA, /Promise\.resolve/);
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "src/read.ts");
  assert.match(readFileSync(path.join(root, "src/read.ts"), "utf8"), /state\/cache/);
  git(root, "commit", "-m", "commit A: behavioral change");
  execFileSync("git", ["apply", "--cached", "--check", "--binary", "-"], {
    cwd: root,
    input: firstPlan.b.patch,
  });

  const secondPlan = buildSplitPlan(root);
  assert.equal(secondPlan.report.behavioral.length, 0);
  assert.ok(secondPlan.report.mechanical.length >= 2);
  stageSplitPart(secondPlan, "b");
  const stagedB = git(root, "diff", "--cached", "--name-status", "--find-renames");
  assert.match(stagedB, /src\/lib\/cache\.ts.*src\/state\/cache\.ts/s);
  assert.match(git(root, "show", ":src/read.ts"), /state\/cache/);
  git(root, "commit", "-m", "commit B: mechanical refactor");

  assert.equal(git(root, "status", "--porcelain"), "");
  const messages = git(root, "log", "-2", "--format=%s").trim().split("\n");
  assert.deepEqual(messages, [
    "commit B: mechanical refactor",
    "commit A: behavioral change",
  ]);
});

test("split CLI writes hashed artifacts and leaves the index untouched", () => {
  const root = repository({ "src/value.ts": "export const value = 1;\n" });
  write(root, "src/value.ts", "export const value = 2;\n");
  const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/cli/index.js",
  );
  const beforeIndex = git(root, "diff", "--cached", "--name-only");
  const output = execFileSync(process.execPath, [cliPath, "split", "--cwd", root], {
    encoding: "utf8",
  });
  const afterIndex = git(root, "diff", "--cached", "--name-only");
  const artifactDirectory = path.join(root, ".semantic-split");
  const patchA = readFileSync(path.join(artifactDirectory, "commit-a.patch"));
  const manifest = JSON.parse(
    readFileSync(path.join(artifactDirectory, "manifest.json"), "utf8"),
  ) as { patches: { a: { sha256: string }; b: { sha256: string } } };

  assert.match(output, /Git index modified: no/);
  assert.equal(afterIndex, beforeIndex);
  assert.ok(existsSync(path.join(artifactDirectory, "commit-b.patch")));
  assert.ok(existsSync(path.join(artifactDirectory, "report.json")));
  assert.equal(
    manifest.patches.a.sha256,
    createHash("sha256").update(patchA).digest("hex"),
  );
  const followupPlan = buildSplitPlan(root);
  assert.equal(followupPlan.report.behavioral.length, 1);
});

test("planning uses temporary objects and does not write the repository object database", () => {
  const root = repository({ "src/value.ts": "export const value = 1;\n" });
  write(root, "src/value.ts", "export const value = 2;\n");
  const before = git(root, "count-objects", "-v");
  buildSplitPlan(root);
  const afterPlan = git(root, "count-objects", "-v");
  assert.equal(afterPlan, before);
});

test("staging refuses an existing index and preserves it byte-for-byte logically", () => {
  const root = repository({ "src/value.ts": "export const value = 1;\n" });
  write(root, "src/value.ts", "export const value = 2;\n");
  git(root, "add", "src/value.ts");
  const before = git(root, "diff", "--cached", "--binary");
  const plan = buildSplitPlan(root);
  assert.throws(() => stageSplitPart(plan, "a"), /index already contains staged changes/);
  assert.equal(git(root, "diff", "--cached", "--binary"), before);
});

test("commit A patch stages unmatched additions and deletions", () => {
  const root = repository({ "src/old.ts": "export const oldValue = 1;\n" });
  unlinkSync(path.join(root, "src/old.ts"));
  write(root, "src/new.ts", "export const newValue = 2;\n");
  const plan = buildSplitPlan(root);
  stageSplitPart(plan, "a");
  const status = git(root, "diff", "--cached", "--name-status");
  assert.match(status, /^A\s+src\/new\.ts/m);
  assert.match(status, /^D\s+src\/old\.ts/m);
});

test("commit B patch can stage a pure file move while A stays empty", () => {
  const root = repository({ "src/lib/value.ts": "export const value = 1;\n" });
  move(root, "src/lib/value.ts", "src/state/value.ts");
  const plan = buildSplitPlan(root);
  assert.equal(plan.a.metadata.files, 0);
  assert.equal(plan.b.metadata.files, 1);
  stageSplitPart(plan, "b");
  assert.match(
    git(root, "diff", "--cached", "--name-status", "--find-renames"),
    /^R100\s+src\/lib\/value\.ts\s+src\/state\/value\.ts/m,
  );
});

test("binary non-source changes are preserved in commit A", () => {
  const root = repository({
    "src/value.ts": "export const value = 1;\n",
    "asset.bin": "\u0000\u0001\u0002",
  });
  const expected = Buffer.from([0, 9, 255, 4]);
  writeFileSync(path.join(root, "asset.bin"), expected);
  const plan = buildSplitPlan(root);
  assert.match(plan.a.patch.toString("utf8"), /GIT binary patch/);
  stageSplitPart(plan, "a");
  const staged = execFileSync("git", ["show", ":asset.bin"], {
    cwd: root,
    encoding: "buffer",
  });
  assert.deepEqual(staged, expected);
});

test("stage-a CLI stages the planned intermediate tree", () => {
  const root = repository({ "src/value.ts": "export const value = 1;\n" });
  write(root, "src/value.ts", "export const value = 2;\n");
  const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/cli/index.js",
  );
  const output = execFileSync(process.execPath, [cliPath, "stage-a", "--cwd", root], {
    encoding: "utf8",
  });
  assert.match(output, /Staged commit A: 1 files/);
  assert.match(git(root, "show", ":src/value.ts"), /value = 2/);
});
