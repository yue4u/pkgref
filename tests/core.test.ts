import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  INDEX_MARKER,
  discoverDependencies,
  findReferenceDirectories,
  groupRepositories,
  mergeIndexes,
  normalizeRepository,
  parsePackageList,
  readManifest,
  renderAgentsReference,
  renderIndex,
  repositoryFromMetadata,
} from "../src/core.ts";

test("core discovers dependencies from the repository package.json fixture", async () => {
  const manifest = await readManifest(join(import.meta.dirname, "..", "package.json"));

  expect(discoverDependencies(manifest)).toEqual([
    "@clack/prompts",
    "@types/node",
    "bumpp",
    "typescript",
    "vite",
    "vite-plus",
  ]);
});

test("combines all dependency fields and deduplicates names", () => {
  expect(
    discoverDependencies({
      dependencies: { zod: "1" },
      devDependencies: { react: "1", zod: "2" },
      optionalDependencies: { sharp: "1" },
      peerDependencies: { react: "1", vite: "1" },
    }),
  ).toEqual(["react", "sharp", "vite", "zod"]);
});

test("parses explicit package lists", () => {
  expect(parsePackageList(" react,vitest, react, ")).toEqual(["react", "vitest"]);
});

test("adds and updates an idempotent AGENTS.md reference", () => {
  const initial = "# Instructions\n";
  const added = renderAgentsReference(initial, "docs/reference/INDEX.md");

  expect(added).toContain("# Instructions");
  expect(added).toContain("[package reference index](docs/reference/INDEX.md)");

  const updated = renderAgentsReference(added, "docs/repo/INDEX.md");
  expect(updated).toContain("[package reference index](docs/repo/INDEX.md)");
  expect(updated).not.toContain("docs/reference/INDEX.md");
  expect(updated.match(/<!-- PKGREF START -->/g)).toHaveLength(1);
});

test("normalizes repository metadata and Git URL variants", () => {
  expect(normalizeRepository("git+https://GitHub.com/VoidZero-dev/vite-plus.git")).toEqual({
    cloneUrl: "https://github.com/VoidZero-dev/vite-plus.git",
    key: "github.com/voidzero-dev/vite-plus",
    name: "vite-plus",
  });
  expect(normalizeRepository("git@github.com:microsoft/TypeScript.git")).toMatchObject({
    key: "github.com/microsoft/typescript",
    name: "TypeScript",
  });
  expect(repositoryFromMetadata({ repository: "github:antfu-collective/bumpp" })).toMatchObject({
    key: "github.com/antfu-collective/bumpp",
    name: "bumpp",
  });
});

test("deduplicates repositories and records their packages", () => {
  const repository = normalizeRepository("https://github.com/voidzero-dev/vite-plus.git");
  expect(
    groupRepositories([
      { name: "vite", repository },
      { name: "vite-plus", repository },
    ]),
  ).toEqual([{ ...repository, packages: ["vite", "vite-plus"] }]);
});

test("rejects basename collisions from different repositories", () => {
  expect(() =>
    groupRepositories([
      {
        name: "one",
        repository: normalizeRepository("https://github.com/one/shared.git"),
      },
      {
        name: "two",
        repository: normalizeRepository("https://github.com/two/shared.git"),
      },
    ]),
  ).toThrow(/folder collision/);
});

test("finds and renders docs and examples deterministically", async () => {
  const target = join(import.meta.dirname, "fixtures", "target");
  const repository = join(target, "sample");

  expect(await findReferenceDirectories(repository, target)).toEqual([
    { label: "docs", path: "sample/docs" },
    {
      label: "packages/widget/examples",
      path: "sample/packages/widget/examples",
    },
  ]);

  const index = await renderIndex(
    [{ directory: "sample", packages: ["sample-core", "sample"], root: repository }],
    target,
  );
  expect(index).toContain(INDEX_MARKER);
  expect(index).toContain("Packages: `sample`, `sample-core`");
  expect(index).toContain("[docs](./sample/docs)");
  expect(index).toContain("[packages/widget/examples](./sample/packages/widget/examples)");
  expect(index).not.toContain("start.md");
  expect(index).not.toContain("basic.mdx");
  expect(index).not.toContain("ignored.md");
});

test("links the repository root when it has no docs or examples", async () => {
  const target = join(import.meta.dirname, "fixtures", "target");
  const repository = join(target, "empty");

  const index = await renderIndex(
    [{ directory: "empty", packages: ["empty"], root: repository }],
    target,
  );
  expect(index).toContain("[Repository root](./empty)");
});

test("merges rerun output without losing previous repository sections", () => {
  const existing = `${INDEX_MARKER}

# Package references

## alpha

Packages: \`alpha\`

- [docs](./alpha/docs)

## shared

Packages: \`old-package\`

- [docs](./shared/docs)
`;
  const generated = `${INDEX_MARKER}

# Package references

## beta

Packages: \`beta\`

- [examples](./beta/examples)

## shared

Packages: \`new-package\`

- [examples](./shared/examples)
`;

  const merged = mergeIndexes(existing, generated);

  expect(merged).toContain("## alpha");
  expect(merged).toContain("## beta");
  expect(merged).toContain("Packages: `new-package`");
  expect(merged).not.toContain("Packages: `old-package`");
  expect(merged.indexOf("## alpha")).toBeLessThan(merged.indexOf("## beta"));
  expect(merged.indexOf("## beta")).toBeLessThan(merged.indexOf("## shared"));
});

test("reports malformed manifests with their path", async () => {
  const manifestPath = join(import.meta.dirname, "fixtures", "malformed-package.txt");

  await expect(readManifest(manifestPath)).rejects.toThrow(
    `Invalid package manifest at ${manifestPath}`,
  );
});
