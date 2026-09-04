# split-commit

[![Npm package version](https://badgen.net/npm/v/split-commit)](https://npmjs.com/package/split-commit)
[![Publish npm package](https://github.com/leesj-dev/split-commit/actions/workflows/publish.yml/badge.svg)](https://github.com/leesj-dev/split-commit/actions/workflows/publish.yml)
[![GitHub license](https://badgen.net/github/license/leesj-dev/split-commit)](https://github.com/leesj-dev/split-commit?tab=MIT-1-ov-file)

`split-commit` separates a mixed JavaScript/TypeScript refactor into two commits:

- **A**: code changes that may change behavior, plus anything uncertain
- **B**: structural changes the tool can verify with high confidence (**file moves, file name changes, import-path updates**)

If something breaks later, the Git history is easier to inspect because mechanical cleanup is isolated from changes that could have affected behavior.

**Example:** Suppose you move `src/lib/cache.ts` to `src/state/cache.ts`, update every import, and change the cache invalidation logic. `split-commit` produces:

```text
commit A  change cache invalidation logic
commit B  move cache.ts and update its import paths
```

![Diagram](diagram.png)

## Installation

Requires Node.js 20+.

```bash
npm install -g split-commit
```

### Codex Desktop

Install the repository skill with Codex's built-in skill installer:

```text
$skill-installer install the split-commit skill from
https://github.com/leesj-dev/split-commit/tree/main/.agents/skills/split-commit
```

Then open the repository you want to inspect, choose the model and reasoning
effort in the task UI, and invoke `$split-commit`. The skill runs the installed
`split-commit` executable underneath, but the user does not need to construct
review flags or run a second coding-agent session.

### Claude Code

The Claude Code project skill lives at `.claude/skills/split-commit`. Copy that
directory to `~/.claude/skills/split-commit` to make it available in every
repository, or check it into a target repository for project-only use. Select
the session model and effort normally, then invoke:

```text
/split-commit preview my working-tree split
```

Claude reviews ambiguous entries in the current session and does not launch a
nested Claude Code CLI process.

## Quick start

Run inside a repository with at least one commit. `split-commit` compares the current working tree with `HEAD`.

```bash
# See how changes are classified.
split-commit report            # summary
split-commit report --verbose  # with evidence

# Let a local coding agent make the final A/B decision for ambiguous changes.
split-commit report --verbose --review codex --model gpt-5.6-terra --effort high
split-commit report --verbose --review claude --model sonnet --effort high

# Preview the A → B plan without committing.
split-commit apply --dry-run

# Create A and B commits.
split-commit apply

# Optionally provide custom commit messages.
split-commit apply "Implement cache invalidation" "Move cache module into state"
```

If A or B is empty, that commit is skipped. Default messages are `Apply behavioral changes` and `Apply mechanical structural refactor`.

## Commands

| Command            | Description                                     |
| ------------------ | ----------------------------------------------- |
| `report`           | Show A/B/ambiguous classifications              |
| `report --verbose` | Include the evidence behind each classification |
| `report --json`    | Print the report as JSON                        |
| `split --dry-run`  | Display the split plan without writing anything |
| `split`            | Write A/B patch files and verification metadata |
| `stage-a`          | Stage only A (does not commit)                  |
| `stage-b`          | Stage only B, after A has been committed        |
| `apply`            | Create A and B commits in order                 |

Add `--review codex` or `--review claude` to any command
to have that local coding agent review every ambiguous classification. The
agent's A/B decisions are authoritative and directly change the generated,
staged, or committed patches. Without this flag, ambiguous changes continue to
default to A.

All commands accept `--cwd <path>` to target another repository.  
`--dry-run` works with `split`, `stage-a`, `stage-b`, and `apply`.

## What goes into A, B, and Ambiguous

`split-commit report` prints three sections. The `kind` values below are the
exact values shown by `report --verbose` and `report --json`.

### Mechanical changes (B)

**B** is narrow by design: it contains only high-confidence structural edits.

| Report `kind` | Included change |
| --- | --- |
| `file-move` | A JS/TS file was moved or renamed with its code and comments otherwise unchanged. |
| `import-path-update` | An `import` specifier was updated to follow a verified move. |
| `export-path-update` | An `export ... from` specifier was updated to follow a verified move. |
| `barrel-update` | An export path was updated in a barrel file such as `index.ts`. |

A changed path string alone is not enough. The tool resolves both old and new
specifiers and confirms they point to the same module, or to a file whose move
was independently verified.

### Behavioral changes (A)

**A** is the safe default. These entries are directly included in A:

| Report `kind` | Included change |
| --- | --- |
| `source-modification` | A JS/TS edit changes normalized AST or comments beyond recognized module-path updates, or a move candidate fails structural validation. |
| `source-addition` | New JS/TS source with no proven predecessor. |
| `source-deletion` | Deleted JS/TS source with no proven successor. |
| `non-source-change` | Any non-JS/TS change, which the structural classifier does not certify. |

### Ambiguous (defaults to A)

These entries are kept separate in the report because the deterministic
classifier cannot safely make the A/B decision. Without `--review`, all of
them are included in A; an AI reviewer may explicitly assign each one to A or
B.

| Report `kind` | Why it is ambiguous |
| --- | --- |
| `unresolved-module-update` | Old and new module specifiers do not resolve to a proven-identical target. |
| `unsafe-module-update` | A side-effect-only import changed, so module initialization order may be observable. |
| `unsupported-formatting` | AST and comments are unchanged, but standalone formatting is not yet certified as mechanical. |

A single file can contain both kinds of changes. For example, if `App.ts` changes an import path and also changes component logic, the logic goes to A and the verified import edit goes to B.

> Putting a real behavior change in B would make the split misleading. Putting a harmless refactor in A is less convenient, but does not weaken the safety of B.

### AI review of ambiguous changes

The deterministic classifier always runs first. It resolves the old tree with
the `HEAD` TypeScript configuration and the new tree with the working-tree
configuration, so a `tsconfig.json` alias migration can be certified without
AI when both snapshots prove the same module identity.

Only the remaining ambiguous entries are sent to the selected reviewer:

```bash
split-commit split --review codex
split-commit apply --review claude

# Optional provider-specific model and reasoning overrides
split-commit report --review codex --model <model> --effort <level>
```

Codex runs through `codex exec` with an ephemeral, read-only sandbox and a JSON
output schema. Claude Code runs in non-interactive restricted mode with a JSON
schema and no persistent session. The reviewer must return exactly one valid
A/B decision for every ambiguous entry; a missing, duplicate, or invalid
decision stops the command instead of silently falling back.

#### Codex Desktop and Claude Code skills

The repository includes a `split-commit` skill under `.agents/skills`. In Codex
Desktop, select the model and reasoning effort in the task UI, then invoke
`$split-commit` and ask it to inspect or split the working tree. The current
task reviews the ambiguous entries itself; it does not launch a second Codex
CLI process. The skill passes its structured decisions back through
`--review file --file <path>` and verifies the resulting A/B plan.

Claude Code uses the matching project skill under `.claude/skills`. Invoke it
as `/split-commit`; it uses the current Claude session's model and effort and
the same structured decision-file handoff.

The default skill action is a dry-run preview. It writes patches, stages files,
or creates commits only when the prompt requests that operation.

Other agents can integrate through the command adapter protocol:

```bash
split-commit report \
  --review command \
  --command /absolute/path/to/reviewer-adapter
```

The executable receives one JSON request on standard input and must return:

```json
{
  "decisions": [
    {
      "classificationId": "id from request.candidates",
      "destination": "A",
      "confidence": "high",
      "reason": "Why this belongs in A"
    }
  ]
}
```

The request also includes the repository path, base commit, relevant diff,
candidate evidence, and the exact output JSON Schema.

---

## Details

### Safety rules

- The Git index must be clean (no staged changes) before any staging command.
- Unstaged and untracked files are analyzed normally.
- If a Git hook modifies commit A, or the working tree changes after A is committed, automatic processing stops before B.

### Manual workflow

Use `stage-a` and `stage-b` when you want to inspect and commit each part yourself:

```bash
split-commit stage-a
git diff --cached
git commit -m "behavioral changes"

split-commit stage-b
git diff --cached
git commit -m "mechanical structural refactor"
```

`stage-b` must be run after A has been committed. If A candidates still remain, it exits without staging.

### Git alias

```bash
git config --global alias.split-commit '!split-commit apply'

# Then:
git split-commit
git split-commit "Custom A message" "Custom B message"

# Remove:
git config --global --unset alias.split-commit
npm uninstall -g split-commit
```

### Patch files

`split-commit split` writes:

```text
.split-commit/
  commit-a.patch   # HEAD → A-only version
  commit-b.patch   # A-only version → A+B (assumes A already applied)
  manifest.json    # hashes, file counts, tree IDs for verification
  report.json      # classification results
```

Use `--output-dir <path>` to change the output location.

### Reading a classification

Verbose output may include entries like:

```text
import-path-update      src/App.ts:4
  Reason: Both specifiers resolve to the same module identity or a proven file move
  - old "@/common/lib/DataCacheContext" -> src/common/lib/DataCacheContext.tsx
  - new "@/common/state/DataCacheContext" -> src/common/state/DataCacheContext.tsx
```

The import text changed, but the resolver confirmed the old and new paths refer to the same module before and after a verified move, so this edit qualifies for B.

### How B is verified

For a file move to qualify for B:

1. The JS/TS syntax and comments still match after accounting for import/export paths.
2. One old file matches exactly one new file, with no ambiguous duplicate.
3. The file does not use path-sensitive constructs the checker cannot handle safely (dynamic imports, `require()`, `import.meta`, `__dirname`, `__filename`, side-effect-only imports, reflection, string-based module references, bundler-specific behavior).
4. Static imports and exports resolve successfully before and after the refactor.
5. Each resolved dependency is the same file, or another file whose move was also verified.

The tool uses the TypeScript Compiler API to parse source files and resolve modules against both `HEAD` and the current working tree.

### Current limits

These changes fall back to A:

- Renaming a symbol and proving every reference still points to the same declaration
- Moving a declaration from one file to another
- Standalone formatting or import sorting
- Arbitrary JS/TS changes that would require proving two programs behave identically

## Compared with other tools

| Tool           | Main job                                                                         |
| -------------- | -------------------------------------------------------------------------------- |
| difftastic     | Syntax-aware diffs                                                               |
| `jj split`     | Interactive commit splitting                                                     |
| `git add -p`   | Manual hunk-by-hunk staging                                                      |
| git-absorb     | Assign changes to earlier commits                                                |
| `split-commit` | Automatically separate verified structural refactors from behavior-changing code |

## Project structure

```text
src/
  git/          Git working-tree collection and move detection
  ts/           TypeScript/JavaScript parsing and module resolution
  classifier/   A/B classification
  planner/      patch generation, staging, and commit planning
  cli/          command-line interface
```
