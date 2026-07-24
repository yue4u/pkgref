# pkgref

[GitHub repository](https://github.com/yue4u/pkgref)

```sh
pnpm dlx pkgref
# list package.json deps in interactive mode for select and clone repo to target dir (default to docs/pkg-reference).
pnpm dlx pkgref --pkgs=react,vitest --dir docs/repo
# specify pkg and dir to clone with cli param
pnpm dlx pkgref update
# fast-forward all clones in docs/pkg-reference
```

## Features

- list docs/example dir in cloned repo to root as index markdown for search

## Future

- support more than package.json

## Development

- Install dependencies:

```bash
vp install
```

- Run the unit tests:

```bash
vp test
```

- Build the library:

```bash
vp pack
```
