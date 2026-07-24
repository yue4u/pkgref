# pkgref v1 specification

`pkgref` reads dependency names from the current directory's `package.json`,
lets the user select packages, clones their source repositories, and creates a
searchable documentation index.

## CLI

```text
pkgref [--pkgs=<name,...>] [--dir=<path>]
pkgref update [--dir=<path>]
pkgref --help
pkgref --version
```

Both commands resolve `--dir` from the current working directory and default to
`docs/pkg-reference`.

### Clone command

- Package candidates come from `dependencies`, `devDependencies`,
  `peerDependencies`, and `optionalDependencies`.
- Without `--pkgs`, an interactive scrolling checkbox picker is shown. Arrow
  keys move the cursor, Space toggles packages, and Enter confirms.
- After resolving and deduplicating repositories, interactive mode displays
  every normalized Git clone URL with its folder and package mappings, then
  requires confirmation before any filesystem changes.
- Interactive mode then asks for the target directory unless `--dir` was
  supplied, followed by an optional confirmation to add the generated index to
  `AGENTS.md`. Both confirmations default to Yes.
- Explicit undeclared package names are accepted with a warning.
- The clone command requires a valid project-root `package.json`. Supplying
  `--pkgs` skips all interactive prompts.

### Update command

- `pkgref update` does not read or require a package manifest and rejects
  `--pkgs`.
- It discovers immediate child directories containing `.git` under the target;
  other files and directories are ignored.
- Repositories are processed in lexical order. Each clean worktree runs
  `git pull --ff-only --prune`, updating its checked-out branch from the
  configured upstream without rewriting history.
- Dirty repositories are preserved and reported as failures. Inspection or
  pull failures do not stop remaining repositories.
- A missing target or target without clones is a successful no-op. Any skipped
  or failed clone makes the final exit code nonzero.

## Repositories

Repository metadata is resolved from npm. Repositories are normalized and
deduplicated by URL, then shallow-cloned from their current default branch.
Clone directories use the repository basename; conflicting basenames are
reported before any clone is created.

When a destination exists, interactive users may update or skip it, with skip
as the default. Non-interactive runs skip it. Updates require a matching origin
and clean worktree and use `git pull --ff-only`. Existing unrelated paths are
never modified.

## Index

One generated `INDEX.md` is written directly in the target directory, outside
the cloned repositories. It contains a section for every valid repository and
links only to directories named `doc`, `docs`, `example`, or `examples`.
Matching directories are discovered recursively so monorepo package docs are
included, but their individual files are not listed.

Repository sections, package names, and links have deterministic ordering. A
repository without matching documentation or example directories links to its
repository root instead. On rerun, existing generated repository sections are
preserved; sections processed in the current run are replaced and new sections
are added. pkgref refuses to overwrite a user-owned `INDEX.md` without its
generated-file marker.

When confirmed interactively, pkgref adds a marked, idempotent section to the
project-root `AGENTS.md` linking to the generated index. A later run updates
that section rather than adding a duplicate, and an absent `AGENTS.md` is
created.

## Safety and failures

External commands receive argument arrays without shell interpolation. A
failure to resolve, clone, update, or index a repository is reported and makes
the process exit nonzero. Successful repositories are retained and indexed.
Skipping an existing repository is not an error.

Version-specific checkouts, forced resets, full-history clones, manifests other
than `package.json`, private-registry configuration, and custom documentation
directory patterns are outside v1.
