# semantic-split

`semantic-split` makes large refactors easier to investigate by classifying a
Git working tree according to semantic intent:

- **A — behavioral / logic changes:** anything that may affect runtime behavior,
  data flow, control flow, API contracts, side effects, or anything the tool
  cannot prove safe.
- **B — mechanical / structural refactors:** only changes backed by strong,
  explainable evidence that source meaning was preserved.

The desired history is:

```text
commit A  actual behavioral / logic changes
commit B  provably mechanical structural refactor
```

This is not merely a diff splitter. Its purpose is to separate semantic intent
so that, after a large refactor, regression investigation can start with commit
A when commit B has passed conservative mechanical checks.

## Conservative policy

```text
high-confidence, explainable semantics preservation  → B
anything unresolved, unsafe, or unsupported          → A
```

The report displays ambiguous items separately for review, but the split policy
assigns them to A. False negatives are acceptable in the initial version; false
positives in B are not.

JavaScript and TypeScript do not permit a general formal equivalence proof.
Module initialization order, side-effect imports, dynamic imports,
`import.meta`, `__dirname`, `__filename`, `require()`, reflection, string-based
module references, and bundler-specific transforms can all be observable.
The classifier therefore certifies a narrow set and rejects or defers everything else.

## Implemented phases

### Phase 1 — semantic classification

Implemented:

- Git `HEAD` versus working-tree collection, including staged, unstaged, and
  untracked files
- Git rename hints plus independent delete/add move discovery
- normalized TypeScript/JavaScript AST and comment comparison
- TypeScript Compiler API module resolution using `tsconfig.json`, `baseUrl`,
  `paths`, relative imports, extension lookup, and `index.ts` lookup
- content-preserving file move classification
- import, export, and barrel path update classification when both sides resolve
  to the same file identity or a proven move pair
- mixed-file reporting: a proven import-path update can be B while the remaining
  AST edit in the same file is A
- human-readable reasons, verbose resolution evidence, and JSON output
- end-to-end tests that create real temporary Git repositories

### Phase 2 — patch generation and safe staging

- sequential patch synthesis:
  - `commit-a.patch`: `HEAD` → behavioral/ambiguous intermediate tree
  - `commit-b.patch`: intermediate A tree → complete working-tree result
- AST-span mixed-file splitting: only proven module specifiers are withheld from A
- temporary Git indexes and `write-tree` verification for every generated state
- temporary object databases, so report/dry-run/artifact planning does not add
  unreachable objects to the analyzed repository
- SHA-256, byte count, file count, base commit, and target tree IDs in a manifest
- atomic artifact writes under `.semantic-split/` by default
- `stage-a` and `stage-b` commands that preserve the complete working tree
- `apply` command that stages and commits A, reanalyzes, then stages and commits B
- clean-index precondition: existing staged changes are rejected without modification
- enforced order: B cannot be staged while A candidates remain
- post-commit tree verification: if a Git hook changes A or the working tree,
  automatic B processing stops
- file modes, symlinks, additions, deletions, renames, and binary Git patches

Deliberately deferred to later phases:

- symbol rename and reference-identity proof
- declaration/function/class moves between files
- configurable typecheck/test validation hooks
- standalone formatting/import-sort certification

## Installation and use

Requirements: Git and Node.js 20 or newer.

### Install on another computer

After cloning or copying this repository onto the other computer:

```bash
npm ci
npm run build
npm install -g .

# Confirm that the CLI is on PATH.
semantic-split --help

# Add the Git-style command for the current user on that computer.
git config --global alias.semantic-split '!semantic-split apply'

# Confirm the integration without creating commits.
git semantic-split --dry-run
```

`npm install -g .` installs the built checkout as a normal global package. For
development, use `npm link` instead so edits in the checkout are reflected
without reinstalling:

```bash
npm ci
npm run build
npm link
git config --global alias.semantic-split '!semantic-split apply'
```

If the repository itself cannot be cloned on the destination computer, create
a package archive and transfer that single file:

```bash
# On the source computer
npm ci
npm run build
npm pack

# Copy semantic-split-0.3.0.tgz to the destination computer, then run there
npm install -g ./semantic-split-0.3.0.tgz
git config --global alias.semantic-split '!semantic-split apply'
git semantic-split --dry-run
```

The alias is stored in that computer's user-level Git configuration. It works
in every repository for that user, but must be registered once per computer.
Inspect or remove the installation with:

```bash
git config --global --get alias.semantic-split
git config --global --unset alias.semantic-split
npm uninstall -g semantic-split
```

### Commands

```bash
semantic-split report
semantic-split report --verbose
semantic-split report --json
semantic-split split --dry-run --verbose
semantic-split split
semantic-split stage-a
semantic-split stage-b
semantic-split apply

# Equivalent one-command Git alias after the setup above
git semantic-split
git semantic-split "Custom A"
git semantic-split "Custom A" "Custom B"
```

Run against another repository without changing directory:

```bash
semantic-split report --cwd /path/to/repository
```

The repository needs an initial commit because analysis compares `HEAD` with
the complete current working tree.

## Safe A → B workflow

Start with a clean index. Staged, unstaged, and untracked working-tree content
may be analyzed, but staging commands intentionally refuse a pre-existing index
so they cannot overwrite the user's staged state.

```bash
# 1. Inspect classifications and generated patch metadata. No writes.
semantic-split split --dry-run --verbose

# 2. Optionally write sequential patches, report.json, and manifest.json.
#    This does not touch the index.
semantic-split split

# 3. Stage only behavioral and ambiguous changes.
semantic-split stage-a
git diff --cached
git commit -m "behavioral changes"

# 4. Reanalyze against the new HEAD, then stage the mechanical remainder.
semantic-split stage-b
git diff --cached
git commit -m "mechanical structural refactor"
```

`stage-b` must be rerun after committing A. If A candidates still exist, it
exits without changing the index. Neither staging command commits automatically.

### One-command apply

`apply` performs the complete workflow: analyze → stage/commit A → reanalyze →
stage/commit B. Commit messages are positional and assigned from A to B:

```bash
# Both default messages
semantic-split apply

# Custom A message; B keeps its default
semantic-split apply "Implement cache behavior"

# Custom A and B messages
semantic-split apply \
  "Implement cache behavior" \
  "Move cache context into state module"

# The configured Git alias has the same argument rules
git semantic-split \
  "Implement cache behavior" \
  "Move cache context into state module"
```

Default messages:

```text
A  Apply behavioral changes
B  Apply mechanical structural refactor
```

An empty A or B patch is skipped without creating an empty commit. Use
`semantic-split apply --dry-run` to see the resolved messages and planned
commits without staging or committing anything. Existing Git hooks run normally;
the command verifies each resulting tree and does not continue to B if commit A
or the working tree differs from the verified plan.

### Patch artifacts

By default `split` writes:

```text
.semantic-split/
  commit-a.patch
  commit-b.patch
  manifest.json
  report.json
```

Use `--output-dir <path>` to choose a different location. The B artifact is a
sequential patch whose base is the A target tree, not an independent patch
against the original `HEAD`. The manifest records this chain through tree IDs
and patch hashes.

### Explanation example

```text
import-path-update      src/App.ts:4
  Reason: Both specifiers resolve to the same module identity or a proven file move
  - old "@/common/lib/DataCacheContext" → src/common/lib/DataCacheContext.tsx
  - new "@/common/state/DataCacheContext" → src/common/state/DataCacheContext.tsx
```

## How the proof boundary works

A file-move candidate must pass all of these checks:

1. Its normalized AST and comment tokens match after static module specifiers
   are canonicalized.
2. Candidate matching is one-to-one; duplicate delete/add matches are rejected.
3. It contains no path-sensitive construct currently outside the proof model.
4. Every static import/export resolves in the old and new repository snapshots.
5. Each resolved target is identical, or follows another proven one-to-one move.
6. Side-effect-only imports are not present in the proof.

Import/export path edits are paired structurally, then resolved twice with the
TypeScript Compiler API: once against a virtual `HEAD` filesystem and once
against the current working tree. A changed string alone is never enough.

## Compared with adjacent tools

| Tool | Primary purpose |
| --- | --- |
| difftastic | Syntax-aware diff visualization |
| `jj split` | Interactive commit splitting |
| `git add -p` | Manual hunk-level staging |
| git-absorb | Assign hunks to prior commits |
| semantic-split | Classify mechanical refactors versus behavioral changes using semantic evidence |

## Architecture

```text
src/
  git/          working-tree collection and conservative move detection
  ts/           project loading, AST normalization, module resolution
  classifier/   file move and import/export/barrel classification
  planner/      intermediate trees, sequential patches, artifact/stage orchestration
  cli/          report, split, stage-a, and stage-b commands
```

## Development

```bash
npm run typecheck
npm test
```

The test suite covers the 16 requested fixture classes, including aliases,
relative imports, barrels, `index.ts`, cycles, mixed edits, unresolved imports,
side-effect imports, and rename-like duplicate delete/recreate cases. It also
creates real A/B commits, validates sequential artifacts, checks clean-index
refusal, and proves that staging leaves the full working tree intact. Phase 3
fixtures currently assert the conservative fallback to A.
