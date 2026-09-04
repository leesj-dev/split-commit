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
Phase 1 therefore certifies a narrow set and rejects or defers everything else.

## Phase 1

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
- read-only split dry-run; the current Git index is never modified
- end-to-end tests that create real temporary Git repositories

Deliberately deferred to later phases:

- symbol rename and reference-identity proof
- declaration/function/class moves between files
- patch synthesis and A/B index staging
- automatic commits and validation hooks
- standalone formatting/import-sort certification

## Installation and use

```bash
npm install
npm run build
npm link                 # optional: exposes `semantic-split`

semantic-split report
semantic-split report --verbose
semantic-split report --json
semantic-split split --dry-run --verbose
```

Run against another repository without changing directory:

```bash
semantic-split report --cwd /path/to/repository
```

The repository needs an initial commit because analysis compares `HEAD` with
the complete current working tree. `split` without `--dry-run` exits safely in
Phase 1 rather than mutating the index.

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
  cli/          report and read-only split plan
```

## Development

```bash
npm run typecheck
npm test
```

The test suite covers the 16 requested fixture classes, including aliases,
relative imports, barrels, `index.ts`, cycles, mixed edits, unresolved imports,
side-effect imports, and rename-like duplicate delete/recreate cases. Phase 3
fixtures currently assert the conservative Phase 1 fallback to A.
