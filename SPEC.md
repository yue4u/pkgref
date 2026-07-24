# pkgref v1 behavioral specification

This document is the implementation and testing contract for maintainers.
User-facing guidance and examples belong in [README.md](./README.md).

`pkgref` discovers dependency source repositories, maintains local shallow
clones, and generates a deterministic reference index without modifying cloned
content.

## Requirements

- The runtime is Node.js 24 or newer.
- Git is available on `PATH`.
- The clone command runs from a project root containing `package.json`.
- The update command requires only its target directory.

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
- An empty interactive selection exits successfully without creating files.
- Cancellation at any interactive prompt exits successfully without continuing
  to later prompts or filesystem changes.

### Update command

- `pkgref update` does not read or require a package manifest and rejects
  `--pkgs`.
- It discovers immediate child directories containing `.git` under the target;
  other files and directories are ignored.
- Clean repositories run `git pull --ff-only --prune`, updating their
  checked-out branches from configured upstreams without rewriting history.
- Dirty repositories are preserved and reported as failures. Inspection or
  pull failures do not stop remaining repositories.
- A missing target or target without clones is a successful no-op. Any skipped
  or failed clone makes the final exit code nonzero.

## Repositories

Repository metadata is read first from
`node_modules/<package-name>/package.json`, including scoped package paths. This
uses the exact installed package version and makes installed-package resolution
offline. If the package is not installed, metadata is fetched from
`https://registry.npmjs.org/<encoded-name>/latest`.

The `repository` field may be a string or an object with a `url` property.
GitHub shorthands, SCP-style SSH URLs, `git+` prefixes, and `git://` URLs are
normalized. Only HTTP, HTTPS, and SSH clone URLs are accepted. Repositories are
deduplicated by normalized host and path, then shallow-cloned from their current
default branch.

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

No operation uses a temporary directory. Observable output is written only to
the selected target and, when confirmed, the project-root `AGENTS.md`.

## Non-goals

Version-specific checkouts, forced resets, full-history clones, manifests other
than `package.json`, private-registry configuration, and custom documentation
directory patterns are outside v1.
