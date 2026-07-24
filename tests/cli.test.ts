import { afterEach, expect, test, vi } from "vite-plus/test";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { resolveRepository, runCli } from "../src/cli.ts";

afterEach(() => vi.restoreAllMocks());

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
  const fetch = vi.spyOn(globalThis, "fetch");

  expect(await resolveRepository("@clack/prompts", join(import.meta.dirname, ".."))).toMatchObject({
    key: "github.com/bombshell-dev/clack",
  });
  expect(fetch).not.toHaveBeenCalled();
});
