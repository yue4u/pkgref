# pkgref

Clone dependency source repositories and generate a local index of their docs
and examples for coding agents and humans.

Requires Node.js 24+ and Git.

## Usage

Run from a project containing `package.json`:

```sh
npx pkgref
```

Use the arrow keys to navigate, Space to select packages, and Enter to confirm.
pkgref then shows the Git URLs, asks for a target directory (default:
`docs/pkg-reference`), and offers to link the index from `AGENTS.md`.

Skip prompts by supplying packages and a target:

```sh
npx pkgref --pkgs=react,vitest --dir docs/pkg-reference
```

Update every clean clone in the target:

```sh
npx pkgref update
npx pkgref update --dir docs/other-references
```

## Output

Repositories are shallow-cloned and deduplicated. `INDEX.md` links to nested
`doc`, `docs`, `example`, and `examples` directories, or to the repository root
when none exist. Reruns preserve earlier index entries.

pkgref never overwrites a user-owned index or unrelated path. Existing clones
with local changes are left untouched. Failures return a nonzero exit code
without discarding successful work.

See [SPEC.md](./SPEC.md) for the full behavioral contract.

## Development

```sh
vp install
vp check
vp test
vp pack
```

[GitHub](https://github.com/yue4u/pkgref)
