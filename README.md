# split-commit

`split-commit` separates a mixed JavaScript/TypeScript refactor into two commits:

```text
A  code changes that may change behavior, plus anything uncertain
B  structural changes the tool can verify with high confidence
```

This is useful when one refactor mixes real code changes with file moves and import-path updates. If something breaks later, the Git history is easier to inspect because the mechanical cleanup is separated from the changes that could have changed behavior.

For example, suppose you:

1. move `src/lib/cache.ts` to `src/state/cache.ts`
2. update every import that points to it
3. change the cache invalidation logic

`split-commit` aims to produce this history:

```text
commit A  change cache invalidation logic
commit B  move cache.ts and update its import paths
```

If the tool cannot confidently show that a change belongs in B, it puts that change in A.

## What goes into A and B

### A: behavior changes and uncertain changes

A is the safe default. It can include:

- changes to function or class logic
- changes to control flow, data flow, side effects, or API shape
- new or deleted source files that do not have a proven move partner
- non-JavaScript/TypeScript changes
- formatting-only changes that are not currently certified
- anything the classifier cannot understand well enough to put in B

The report may show some items as `ambiguous` for review, but they are still assigned to A when the split is generated.

### B: verified structural changes

B currently focuses on a narrow set of refactors that can be checked conservatively:

- moving or renaming a TypeScript/JavaScript file without changing its code or comments
- updating `import` and `export` paths to follow a verified file move
- updating paths through barrel files such as `index.ts`, when the old and new paths can both be resolved safely

A changed path string is not enough by itself. The tool resolves the old and new imports and checks that they still point to the same module, or to a file whose move was independently verified.

A single file can contain both kinds of changes. For example, if `App.ts` changes an import path and also changes component logic, the logic can go to A while the verified import-path edit goes to B.

## Why the classifier is conservative

Putting a real behavior change in B would make the split misleading. Putting a harmless refactor in A is less convenient, but it does not weaken the safety of B.

JavaScript and TypeScript also have cases where moving a file or changing a path can affect runtime behavior. Dynamic imports, `require()`, `import.meta`, `__dirname`, `__filename`, side-effect-only imports, reflection, string-based module references, and bundler-specific behavior can all make a seemingly simple refactor observable.

When one of these cases cannot be verified safely, `split-commit` falls back to A.

## Installation

Requirements:

- Git
- Node.js 20 or newer

Clone the repository and install the CLI globally:

```bash
git clone https://github.com/leesj-dev/split-commit.git
cd split-commit
npm ci
npm run build
npm install -g .

split-commit --help
```

For development, use `npm link` instead of `npm install -g .` so local changes are available without reinstalling:

```bash
npm ci
npm run build
npm link
```

### Optional Git alias

You can expose `split-commit apply` as `git split-commit`:

```bash
git config --global alias.split-commit '!split-commit apply'
```

Then run:

```bash
git split-commit
git split-commit "Custom A message"
git split-commit "Custom A message" "Custom B message"
```

Remove the alias or global package with:

```bash
git config --global --unset alias.split-commit
npm uninstall -g split-commit
```

## Quick start

Run these commands inside the repository you want to analyze.

The repository must already have at least one commit because `split-commit` compares the current working tree with `HEAD`.

Start by seeing how the changes are classified:

```bash
split-commit report
```

For more detail:

```bash
split-commit report --verbose
```

Before letting the tool create commits, preview the full A -> B plan:

```bash
split-commit apply --dry-run
```

Then apply it:

```bash
split-commit apply
```

`apply` stages and commits A first, analyzes the remaining changes again, then stages and commits B.

Default commit messages are:

```text
A  Apply behavioral changes
B  Apply mechanical structural refactor
```

You can replace either message:

```bash
split-commit apply \
  "Implement cache invalidation" \
  "Move cache module into state"
```

If A or B is empty, that commit is skipped.

## Safety rules

Commands that stage changes require the Git index to be clean before they start. In practical terms, you should not already have changes staged with `git add`.

Your unstaged and untracked files can still be analyzed. Those are part of the working tree that `split-commit` is trying to separate.

The tool also verifies the planned Git tree before continuing. If a Git hook changes commit A, or the working tree changes after A is committed, automatic processing stops before B.

## Manual A -> B workflow

Use the staging commands when you want to inspect and commit each part yourself:

```bash
# 1. Stage behavior-changing and uncertain changes.
split-commit stage-a
git diff --cached
git commit -m "behavioral changes"

# 2. Analyze the remaining changes again and stage the verified refactor.
split-commit stage-b
git diff --cached
git commit -m "mechanical structural refactor"
```

`stage-b` must be run after A has been committed. If A candidates still remain, it exits without changing the index.

Neither `stage-a` nor `stage-b` creates a commit automatically.

## Commands

| Command | What it does |
| --- | --- |
| `split-commit report` | Shows which changes are classified as A, B, or ambiguous |
| `split-commit report --verbose` | Shows the evidence behind each classification |
| `split-commit report --json` | Prints the report as JSON |
| `split-commit split --dry-run` | Builds and displays the split plan without writing files or staging changes |
| `split-commit split` | Writes A/B patch files and verification metadata |
| `split-commit stage-a` | Stages only A |
| `split-commit stage-b` | Stages only B after A has been committed |
| `split-commit apply` | Creates A and B commits in order |

Use `--cwd` to analyze another repository without changing directories:

```bash
split-commit report --cwd /path/to/repository
```

`--dry-run` also works with `stage-a`, `stage-b`, and `apply`.

## Patch files

Running `split-commit split` writes these files by default:

```text
.split-commit/
  commit-a.patch
  commit-b.patch
  manifest.json
  report.json
```

`commit-a.patch` describes the change from `HEAD` to the A-only version of the project.

`commit-b.patch` starts from that A version and applies the remaining verified structural changes. It assumes A has already been applied; it is not a separate patch against the original `HEAD`.

`manifest.json` records hashes, file counts, commit IDs, and Git tree IDs used to verify the generated plan. `report.json` contains the classification results.

Choose another output directory with:

```bash
split-commit split --output-dir /path/to/output
```

## Reading a classification

Verbose output can include entries like this:

```text
import-path-update      src/App.ts:4
  Reason: Both specifiers resolve to the same module identity or a proven file move
  - old "@/common/lib/DataCacheContext" -> src/common/lib/DataCacheContext.tsx
  - new "@/common/state/DataCacheContext" -> src/common/state/DataCacheContext.tsx
```

In plain terms, the import text changed, but the resolver showed that the old and new paths refer to the corresponding module before and after a verified move. That gives the tool enough evidence to put this path edit in B.

## How B is verified

For a file move to qualify for B, the tool checks that:

1. the TypeScript/JavaScript syntax and comments still match after accounting for import/export paths
2. one old file matches one new file, without an ambiguous duplicate candidate
3. the file does not use a path-sensitive construct that the current checker cannot safely handle
4. static imports and exports resolve successfully before and after the refactor
5. each resolved dependency is the same file, or another file whose move was also verified
6. side-effect-only imports do not appear in the proof

Internally, the tool uses the TypeScript Compiler API to parse source files and resolve modules against both `HEAD` and the current working tree.

## Current limits

These changes are not currently certified as B and normally fall back to A:

- renaming a symbol and proving that every reference still points to the same declaration
- moving a function, class, or declaration from one file to another
- standalone formatting or import sorting
- arbitrary JavaScript/TypeScript changes that would require proving two programs behave identically

The fallback is intentional: B stays small enough that its classifications can be explained and checked.

## Compared with other tools

| Tool | Main job |
| --- | --- |
| difftastic | Shows syntax-aware diffs |
| `jj split` | Interactively splits changes into commits |
| `git add -p` | Lets you manually choose diff hunks to stage |
| git-absorb | Assigns changes to earlier commits |
| `split-commit` | Automatically separates verified structural refactors from behavior-changing or uncertain changes |

## Project structure

```text
src/
  git/          Git working-tree collection and move detection
  ts/           TypeScript/JavaScript parsing and module resolution
  classifier/   A/B classification
  planner/      patch generation, staging, and commit planning
  cli/          command-line interface
```

## Development

```bash
npm run typecheck
npm test
```
