import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "../src/classifier/classify.js";
import type { AnalysisReport, ClassificationKind } from "../src/types.js";

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

function remove(root: string, filePath: string): void {
  unlinkSync(path.join(root, filePath));
}

function move(root: string, oldPath: string, newPath: string): void {
  mkdirSync(path.dirname(path.join(root, newPath)), { recursive: true });
  renameSync(path.join(root, oldPath), path.join(root, newPath));
}

function repository(
  files: Record<string, string>,
  tsconfig: Record<string, unknown> = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    },
    include: ["src"],
  },
): string {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-split-test-"));
  repositories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "semantic-split test");
  write(root, "tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`);
  for (const [filePath, content] of Object.entries(files)) write(root, filePath, content);
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture baseline");
  return root;
}

function kinds(report: AnalysisReport, side: "mechanical" | "behavioral" | "ambiguous"):
  ClassificationKind[] {
  return report[side].map((item) => item.kind);
}

test("1. pure file rename is a proven mechanical move", () => {
  const root = repository({ "src/lib/value.ts": "export const value = 1;\n" });
  move(root, "src/lib/value.ts", "src/state/value.ts");
  const report = analyzeRepository(root);
  assert.deepEqual(kinds(report, "mechanical"), ["file-move"]);
  assert.equal(report.behavioral.length, 0);
});

test("2. file move plus import update is mechanical", () => {
  const root = repository({
    "src/lib/value.ts": "export const value = 1;\n",
    "src/app.ts": 'import { value } from "./lib/value";\nexport const result = value;\n',
  });
  move(root, "src/lib/value.ts", "src/state/value.ts");
  write(root, "src/app.ts", 'import { value } from "./state/value";\nexport const result = value;\n');
  const report = analyzeRepository(root);
  assert.deepEqual(new Set(kinds(report, "mechanical")), new Set(["file-move", "import-path-update"]));
  assert.equal(report.behavioral.length, 0);
});

test("3. alias import update follows TypeScript paths", () => {
  const root = repository({
    "src/lib/value.ts": "export const value = 1;\n",
    "src/app.ts": 'import { value } from "@/lib/value";\nexport { value };\n',
  });
  move(root, "src/lib/value.ts", "src/state/value.ts");
  write(root, "src/app.ts", 'import { value } from "@/state/value";\nexport { value };\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("import-path-update"));
  assert.equal(report.ambiguous.length, 0);
});

test("4. relative import update resolves across a move", () => {
  const root = repository({
    "src/common/lib/cache.ts": "export const cache = new Map();\n",
    "src/features/read.ts": 'import { cache } from "../common/lib/cache";\nexport const read = () => cache.size;\n',
  });
  move(root, "src/common/lib/cache.ts", "src/common/state/cache.ts");
  write(root, "src/features/read.ts", 'import { cache } from "../common/state/cache";\nexport const read = () => cache.size;\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("import-path-update"));
  assert.equal(report.behavioral.length, 0);
});

test("5. barrel export update is classified separately", () => {
  const root = repository({
    "src/lib/Foo.ts": "export class Foo {}\n",
    "src/index.ts": 'export { Foo } from "./lib/Foo";\n',
  });
  move(root, "src/lib/Foo.ts", "src/state/Foo.ts");
  write(root, "src/index.ts", 'export { Foo } from "./state/Foo";\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("barrel-update"));
});

test("6. symbol rename remains behavioral in Phase 1", () => {
  const root = repository({
    "src/user.ts": "export function getUserData() { return 1; }\n",
    "src/app.ts": 'import { getUserData } from "./user";\nexport const value = getUserData();\n',
  });
  write(root, "src/user.ts", "export function fetchUserData() { return 1; }\n");
  write(root, "src/app.ts", 'import { fetchUserData } from "./user";\nexport const value = fetchUserData();\n');
  const report = analyzeRepository(root);
  assert.equal(report.mechanical.length, 0);
  assert.equal(report.behavioral.length, 2);
});

test("7. declaration move remains behavioral in Phase 1", () => {
  const root = repository({
    "src/utils.ts": [
      "export function calculateScore() { return 42; }",
      "export function keepHere() { return true; }",
      "",
    ].join("\n"),
  });
  write(root, "src/utils.ts", "export function keepHere() { return true; }\n");
  write(root, "src/score/calculateScore.ts", "export function calculateScore() { return 42; }\n");
  const report = analyzeRepository(root);
  assert.equal(report.mechanical.length, 0);
  assert.ok(report.behavioral.length >= 1);
});

test("8. rename plus logic modification is not mechanical", () => {
  const root = repository({ "src/getUser.ts": "export const getUser = () => 1;\n" });
  move(root, "src/getUser.ts", "src/fetchUser.ts");
  write(root, "src/fetchUser.ts", "export const fetchUser = async () => 2;\n");
  const report = analyzeRepository(root);
  assert.equal(report.mechanical.length, 0);
  assert.ok(report.behavioral.length >= 1);
});

test("9. file move plus logic modification is not mechanical", () => {
  const root = repository({ "src/lib/value.ts": "export const value = 1;\n" });
  move(root, "src/lib/value.ts", "src/state/value.ts");
  write(root, "src/state/value.ts", "export const value = 2;\n");
  const report = analyzeRepository(root);
  assert.equal(report.mechanical.length, 0);
  assert.ok(report.behavioral.length >= 1);
});

test("10. mixed import path and behavioral edit reports both sides", () => {
  const root = repository({
    "src/lib/cache.ts": "export const cache: Record<string, number> = {};\n",
    "src/read.ts": 'import { cache } from "./lib/cache";\nexport const read = (id: string) => cache[id];\n',
  });
  move(root, "src/lib/cache.ts", "src/state/cache.ts");
  write(root, "src/read.ts", 'import { cache } from "./state/cache";\nexport const read = async (id: string) => await Promise.resolve(cache[id]);\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("import-path-update"));
  assert.ok(kinds(report, "behavioral").includes("source-modification"));
});

test("11. unresolved import update is ambiguous and defaults to A", () => {
  const root = repository({
    "src/app.ts": 'import { value } from "missing-old";\nexport { value };\n',
  });
  write(root, "src/app.ts", 'import { value } from "missing-new";\nexport { value };\n');
  const report = analyzeRepository(root);
  assert.deepEqual(kinds(report, "ambiguous"), ["unresolved-module-update"]);
  assert.equal(report.mechanical.length, 0);
});

test("12. side-effect import path update is ambiguous", () => {
  const root = repository({
    "src/oldSetup.ts": "globalThis.name = \"ready\";\n",
    "src/app.ts": 'import "./oldSetup";\nexport const ready = true;\n',
  });
  move(root, "src/oldSetup.ts", "src/newSetup.ts");
  write(root, "src/app.ts", 'import "./newSetup";\nexport const ready = true;\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "ambiguous").includes("unsafe-module-update"));
});

test("13. explicit baseUrl path alias is resolved", () => {
  const root = repository(
    {
      "src/domain/old/value.ts": "export const value = 1;\n",
      "src/app.ts": 'import { value } from "domain/old/value";\nexport { value };\n',
    },
    {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: "src",
        paths: { "domain/*": ["domain/*"] },
      },
      include: ["src"],
    },
  );
  move(root, "src/domain/old/value.ts", "src/domain/new/value.ts");
  write(root, "src/app.ts", 'import { value } from "domain/new/value";\nexport { value };\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("import-path-update"));
});

test("14. index.ts extension resolution follows the moved target", () => {
  const root = repository({
    "src/lib/index.ts": "export const value = 1;\n",
    "src/app.ts": 'import { value } from "./lib";\nexport { value };\n',
  });
  move(root, "src/lib/index.ts", "src/state/index.ts");
  write(root, "src/app.ts", 'import { value } from "./state";\nexport { value };\n');
  const report = analyzeRepository(root);
  assert.ok(kinds(report, "mechanical").includes("import-path-update"));
});

test("15. mutually dependent moves validate through a provisional cycle map", () => {
  const root = repository({
    "src/oldA/A.ts": 'import { b } from "../oldB/B";\nexport const a = () => b();\n',
    "src/oldB/B.ts": 'import { a } from "../oldA/A";\nexport const b = () => typeof a;\n',
  });
  move(root, "src/oldA/A.ts", "src/newA/A.ts");
  move(root, "src/oldB/B.ts", "src/newB/B.ts");
  write(root, "src/newA/A.ts", 'import { b } from "../newB/B";\nexport const a = () => b();\n');
  write(root, "src/newB/B.ts", 'import { a } from "../newA/A";\nexport const b = () => typeof a;\n');
  const report = analyzeRepository(root);
  assert.equal(kinds(report, "mechanical").filter((kind) => kind === "file-move").length, 2);
  assert.equal(report.behavioral.length, 0);
});

test("16. ambiguous deleted/recreated duplicates are not guessed as renames", () => {
  const root = repository({
    "src/one.ts": "export const value = 1;\n",
    "src/two.ts": "export const value = 1;\n",
  });
  remove(root, "src/one.ts");
  remove(root, "src/two.ts");
  write(root, "src/recreated.ts", "export const value = 1;\n");
  const report = analyzeRepository(root);
  assert.equal(kinds(report, "mechanical").filter((kind) => kind === "file-move").length, 0);
  assert.ok(report.behavioral.length >= 2);
});

test("a rejected dependency move invalidates moves that rely on its identity", () => {
  const root = repository({
    "src/oldA/A.ts": 'import { b } from "../oldB/B";\nexport const a = () => b;\n',
    "src/oldB/B.ts": "export const b = __dirname;\n",
  });
  move(root, "src/oldA/A.ts", "src/newA/A.ts");
  move(root, "src/oldB/B.ts", "src/newB/B.ts");
  write(root, "src/newA/A.ts", 'import { b } from "../newB/B";\nexport const a = () => b;\n');
  const report = analyzeRepository(root);
  assert.equal(kinds(report, "mechanical").filter((kind) => kind === "file-move").length, 0);
});

test("a staged Git rename hint is rejected when duplicate predecessors exist", () => {
  const root = repository({
    "src/one.ts": "export const value = 1;\n",
    "src/two.ts": "export const value = 1;\n",
  });
  remove(root, "src/one.ts");
  remove(root, "src/two.ts");
  write(root, "src/recreated.ts", "export const value = 1;\n");
  git(root, "add", "-A");
  const report = analyzeRepository(root);
  assert.equal(kinds(report, "mechanical").filter((kind) => kind === "file-move").length, 0);
});

test("the compiled CLI reports and dry-runs without touching the index", () => {
  const root = repository({ "src/value.ts": "export const value = 1;\n" });
  write(root, "src/value.ts", "export const value = 2;\n");
  const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/cli/index.js",
  );
  const before = git(root, "diff", "--cached", "--name-only");
  const reportOutput = execFileSync(
    process.execPath,
    [cliPath, "report", "--verbose", "--cwd", root],
    { encoding: "utf8" },
  );
  const dryRunOutput = execFileSync(
    process.execPath,
    [cliPath, "split", "--dry-run", "--cwd", root],
    { encoding: "utf8" },
  );
  const afterIndex = git(root, "diff", "--cached", "--name-only");
  assert.match(reportOutput, /Behavioral changes \(A\): 1/);
  assert.match(dryRunOutput, /Git index modified: no/);
  assert.equal(afterIndex, before);
});
