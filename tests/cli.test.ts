import { afterEach, expect, test, vi } from "vite-plus/test";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  invalidCloneReason,
  processRepository,
  pullRepository,
  resolveRepository,
  runCli,
} from "../src/cli.ts";

afterEach(() => vi.restoreAllMocks());
const fixtures = join(import.meta.dirname, "fixtures");
const repository = {
  cloneUrl: "https://github.com/example/example-package.git",
  key: "github.com/example/example-package",
  name: "example-package",
  packages: ["example-package"],
};

test("prints CLI help", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  expect(await runCli(["--help"])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("pkgref [--pkgs=<name,...>]"));
});

test("prints the package version", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  expect(await runCli(["--version"])).toBe(0);
  expect(log).toHaveBeenCalledWith(packageJson.version);
});

test("rejects unknown CLI options", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  expect(await runCli(["--unknown"])).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown option"));
});

test("accepts update when the target contains no cloned repositories", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  expect(
    await runCli(["update", "--dir", "tests/fixtures/target"], join(import.meta.dirname, "..")),
  ).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("No cloned repositories found"));
});

test("reads repository metadata from installed packages without fetching", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));

  expect(await resolveRepository("example-package", join(fixtures, "project"))).toMatchObject({
    key: repository.key,
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("reports clone failures without indexing the repository", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runGit = vi.fn().mockResolvedValue({ ok: false, output: "clone failed" });

  await expect(processRepository(repository, fixtures, runGit)).resolves.toEqual({
    failed: true,
  });
  expect(runGit).toHaveBeenCalledWith([
    "clone",
    "--depth",
    "1",
    "--",
    repository.cloneUrl,
    join(fixtures, repository.name),
  ]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("clone failed"));
});

test("does not pull dirty repositories", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const runGit = vi.fn().mockResolvedValue({ ok: true, output: " M README.md" });

  await expect(pullRepository("/visible/repository", "example", false, runGit)).resolves.toBe(
    "dirty",
  );
  expect(runGit).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("local changes"));
});

test("detects mismatched origins", async () => {
  const runGit = vi.fn().mockResolvedValue({
    ok: true,
    output: "https://github.com/someone-else/example-package.git",
  });

  await expect(invalidCloneReason("/visible/repository", repository, runGit)).resolves.toContain(
    "different origin",
  );
});

test("reports pull failures", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runGit = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, output: "" })
    .mockResolvedValueOnce({ ok: false, output: "pull failed" });

  await expect(pullRepository("/visible/repository", "example", true, runGit)).resolves.toBe(
    "failed",
  );
  expect(runGit).toHaveBeenLastCalledWith(["pull", "--ff-only", "--prune"], "/visible/repository");
  expect(error).toHaveBeenCalledWith(expect.stringContaining("pull failed"));
});
