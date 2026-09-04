import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMMIT_MESSAGE_A,
  DEFAULT_COMMIT_MESSAGE_B,
} from "../src/planner/applySplit.js";

const repositories: string[] = [];
const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/cli/index.js",
);

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

function mixedRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-split-apply-"));
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
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  write(root, "src/lib/value.ts", "export const value = 1;\n");
  write(
    root,
    "src/app.ts",
    'import { value } from "./lib/value";\nexport const result = value;\n',
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture baseline");

  mkdirSync(path.join(root, "src/state"), { recursive: true });
  renameSync(path.join(root, "src/lib/value.ts"), path.join(root, "src/state/value.ts"));
  write(
    root,
    "src/app.ts",
    [
      'import { value } from "./state/value";',
      "export const result = value + 1;",
      "",
    ].join("\n"),
  );
  return root;
}

function runApply(root: string, messages: string[]): string {
  return execFileSync(
    process.execPath,
    [cliPath, "apply", ...messages, "--cwd", root],
    { encoding: "utf8" },
  );
}

for (const fixture of [
  {
    name: "no messages uses both defaults",
    arguments: [],
    expectedA: DEFAULT_COMMIT_MESSAGE_A,
    expectedB: DEFAULT_COMMIT_MESSAGE_B,
  },
  {
    name: "one message customizes A only",
    arguments: ["Custom feature behavior"],
    expectedA: "Custom feature behavior",
    expectedB: DEFAULT_COMMIT_MESSAGE_B,
  },
  {
    name: "two messages customize A and B in order",
    arguments: ["Custom behavior A", "Custom refactor B"],
    expectedA: "Custom behavior A",
    expectedB: "Custom refactor B",
  },
]) {
  test(`apply ${fixture.name}`, () => {
    const root = mixedRepository();
    const output = runApply(root, fixture.arguments);
    const messages = git(root, "log", "-2", "--format=%s").trim().split("\n");
    assert.deepEqual(messages, [fixture.expectedB, fixture.expectedA]);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.match(output, /Commit A: [0-9a-f]{40}/);
    assert.match(output, /Commit B: [0-9a-f]{40}/);
  });
}

test("apply dry-run resolves one message to A without creating commits", () => {
  const root = mixedRepository();
  const before = git(root, "rev-parse", "HEAD").trim();
  const output = execFileSync(
    process.execPath,
    [cliPath, "apply", "Only A is custom", "--dry-run", "--cwd", root],
    { encoding: "utf8" },
  );
  assert.match(output, /commit A message: "Only A is custom"/);
  assert.match(output, new RegExp(`commit B message: "${DEFAULT_COMMIT_MESSAGE_B}"`));
  assert.match(output, /Commits created: no/);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), before);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("apply rejects a pre-existing staged index before creating a commit", () => {
  const root = mixedRepository();
  git(root, "add", "src/app.ts");
  const before = git(root, "rev-parse", "HEAD").trim();
  const result = spawnSync(process.execPath, [cliPath, "apply", "--cwd", root], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /index already contains staged changes/);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), before);
  assert.notEqual(git(root, "diff", "--cached", "--name-only"), "");
});

test("apply rejects more than two positional commit messages", () => {
  const root = mixedRepository();
  const result = spawnSync(
    process.execPath,
    [cliPath, "apply", "A", "B", "C", "--dry-run", "--cwd", root],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at most two commit messages/);
});

test("one message remains reserved for A when only B has changes", () => {
  const root = mixedRepository();
  write(
    root,
    "src/app.ts",
    'import { value } from "./state/value";\nexport const result = value;\n',
  );
  const output = runApply(root, ["Reserved custom A"]);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), DEFAULT_COMMIT_MESSAGE_B);
  assert.match(output, /Commit A: skipped \(empty\); reserved message "Reserved custom A"/);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("apply creates no empty commits when the working tree is clean", () => {
  const root = mixedRepository();
  git(root, "add", "-A");
  git(root, "commit", "-m", "make fixture clean");
  const before = git(root, "rev-parse", "HEAD").trim();
  const output = runApply(root, []);
  assert.match(output, /Commit A: skipped \(empty\)/);
  assert.match(output, /Commit B: skipped \(empty\)/);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), before);
});
