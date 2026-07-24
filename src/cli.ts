#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { cancel, confirm, isCancel, multiselect, note, text } from "@clack/prompts";
import packageJson from "../package.json" with { type: "json" };
import {
  INDEX_MARKER,
  discoverDependencies,
  errorMessage,
  groupRepositories,
  mergeIndexes,
  normalizeRepository,
  parsePackageList,
  readManifest,
  renderAgentsReference,
  renderIndex,
  repositoryFromMetadata,
} from "./core.ts";
import type { IndexRepository, RegistryPackage, RepositoryGroup } from "./types.ts";

const exec = promisify(execFile);
type GitResult = { ok: boolean; output: string };
type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>;
const DEFAULT_DIR = "docs/pkg-reference";
const CANCELLED = Symbol("cancelled");
const OPTIONS = {
  dir: { type: "string" },
  help: { type: "boolean", short: "h" },
  pkgs: { type: "string" },
  version: { type: "boolean", short: "v" },
} as const;
const HELP = `pkgref - clone package source references

Usage:
  pkgref [--pkgs=<name,...>] [--dir=<path>]
  pkgref update [--dir=<path>]

Options:
  --pkgs  Comma-separated packages. Undeclared packages are allowed with a warning.
  --dir   Target directory (default: ${DEFAULT_DIR}).
  -h, --help  Show this help.
  -v, --version  Show the installed version.

Commands:
  update  Fast-forward all cloned repositories to their latest upstream revision.
`;

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
      strict: true,
    });
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    if (values.version) {
      console.log(packageJson.version);
      return 0;
    }
    if (positionals.length > 1 || (positionals[0] && positionals[0] !== "update")) {
      throw new Error(`unknown command: ${positionals.join(" ")}`);
    }
    if (positionals[0] === "update") {
      if (values.pkgs !== undefined) {
        throw new Error("--pkgs cannot be used with the update command");
      }
      return await updateRepositories(resolve(cwd, values.dir ?? DEFAULT_DIR));
    }
    return await cloneRepositories(cwd, values.pkgs, values.dir);
  } catch (error) {
    if (error === CANCELLED) {
      return 0;
    }
    console.error(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

async function updateRepositories(target: string) {
  if (!(await exists(target))) {
    console.log(`No package reference directory found at ${target}.`);
    return 0;
  }

  const repositories: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory() && (await exists(join(target, entry.name, ".git")))) {
      repositories.push(entry.name);
    }
  }
  repositories.sort();

  if (!repositories.length) {
    console.log(`No cloned repositories found in ${target}.`);
    return 0;
  }

  const updates = await Promise.all(
    repositories.map((name) => pullRepository(join(target, name), name, true)),
  );
  const updated = updates.filter((result) => result === "updated").length;
  const failed = updated !== repositories.length;
  console.log(
    `Finished: ${updated} of ${repositories.length} repositories updated${failed ? " with errors" : ""}.`,
  );
  return failed ? 1 : 0;
}

async function cloneRepositories(cwd: string, packageArgument?: string, directory?: string) {
  const manifestPath = join(cwd, "package.json");
  const declared = discoverDependencies(await readManifest(manifestPath));
  const interactive = packageArgument === undefined;
  let addToAgents = false;
  const packages = interactive ? await selectPackages(declared) : parsePackageList(packageArgument);

  if (!interactive) {
    if (!packages.length) {
      throw new Error("--pkgs must contain at least one package name");
    }
    for (const name of packages.filter((name) => !declared.includes(name))) {
      console.warn(`Warning: "${name}" is not declared in ${manifestPath}; resolving it anyway.`);
    }
  }

  const resolved = (
    await Promise.all(
      packages.map(async (name) => {
        try {
          return { name, repository: await resolveRepository(name, cwd) };
        } catch (error) {
          console.error(`Failed to resolve ${name}: ${errorMessage(error)}`);
          return null;
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  let failed = resolved.length !== packages.length;
  const groups = groupRepositories(resolved);
  if (!groups.length) {
    return failed ? 1 : 0;
  }

  if (interactive) {
    await confirmRepositories(groups);
    const chosenDirectory =
      directory ??
      (await ask(
        text({
          message: "Where should package references be stored?",
          initialValue: DEFAULT_DIR,
          validate: (value) => (!value?.trim() ? "Target directory is required." : undefined),
        }),
      ));
    directory = chosenDirectory.trim();
    addToAgents = await confirmChoice("Add the package reference index to AGENTS.md?");
  }

  const target = resolve(cwd, directory ?? DEFAULT_DIR);
  const indexPath = join(target, "INDEX.md");
  const existingIndex = await readOwnedIndex(indexPath);
  await mkdir(target, { recursive: true });

  const indexed: IndexRepository[] = [];
  for (const group of groups) {
    const result = await processRepository(group, target);
    failed ||= result.failed;
    if (result.index) {
      indexed.push(result.index);
    }
  }

  const generated = await renderIndex(indexed, target);
  await writeFile(indexPath, existingIndex ? mergeIndexes(existingIndex, generated) : generated);
  console.log(`Wrote ${indexPath}`);
  if (addToAgents) {
    await addAgentsReference(cwd, indexPath);
  }
  console.log(
    `Finished: ${indexed.length} repositories indexed, ${failed ? "with errors" : "successfully"}.`,
  );
  return failed ? 1 : 0;
}

export async function resolveRepository(packageName: string, cwd: string) {
  const installedManifest = join(cwd, "node_modules", packageName, "package.json");
  if (await exists(installedManifest)) {
    return repositoryFromMetadata(await readManifest(installedManifest));
  }

  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} ${response.statusText}`);
  }
  return repositoryFromMetadata((await response.json()) as RegistryPackage);
}

export async function processRepository(
  group: RepositoryGroup,
  target: string,
  runGit: GitRunner = git,
): Promise<{ failed: boolean; index?: IndexRepository }> {
  const root = join(target, group.name);
  const index = { directory: group.name, packages: group.packages, root };

  if (!(await exists(root))) {
    console.log(`Cloning ${group.name} (${group.packages.join(", ")})...`);
    const result = await runGit(["clone", "--depth", "1", "--", group.cloneUrl, root]);
    if (!result.ok) {
      console.error(`Failed to clone ${group.name}: ${result.output}`);
      return { failed: true };
    }
    return { failed: false, index };
  }

  const invalidReason = await invalidCloneReason(root, group, runGit);
  if (invalidReason) {
    console.warn(`Skipping ${group.name}: ${invalidReason}`);
    return { failed: false };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !(await confirmUpdate(group.name))) {
    console.log(`Skipped update for ${group.name}.`);
    return { failed: false, index };
  }

  const update = await pullRepository(root, group.name, false, runGit);
  return { failed: update === "failed", index };
}

export async function pullRepository(
  root: string,
  name: string,
  prune = false,
  runGit: GitRunner = git,
) {
  const status = await runGit(["status", "--porcelain"], root);
  if (!status.ok) {
    console.error(`Failed to inspect ${name}: ${status.output}`);
    return "failed" as const;
  }
  if (status.output) {
    console.warn(`Skipped ${name}: the worktree has local changes.`);
    return "dirty" as const;
  }

  console.log(`Updating ${name}...`);
  const pull = await runGit(["pull", "--ff-only", ...(prune ? ["--prune"] : [])], root);
  if (!pull.ok) {
    console.error(`Failed to update ${name}: ${pull.output}`);
    return "failed" as const;
  }
  console.log(`Updated ${name}.`);
  return "updated" as const;
}

export async function invalidCloneReason(
  root: string,
  expected: RepositoryGroup,
  runGit: GitRunner = git,
) {
  const origin = await runGit(["remote", "get-url", "origin"], root);
  if (!origin.ok) {
    return "the destination is not a Git clone with an origin";
  }
  try {
    return normalizeRepository(origin.output).key === expected.key
      ? undefined
      : "the existing clone has a different origin";
  } catch (error) {
    return `cannot read its origin: ${errorMessage(error)}`;
  }
}

async function readOwnedIndex(path: string) {
  const contents = await readOptional(path);
  if (contents === undefined) {
    return undefined;
  }
  if (!contents.startsWith(INDEX_MARKER)) {
    throw new Error(`refusing to overwrite user-owned index at ${path}`);
  }
  return contents;
}

async function selectPackages(packages: string[]) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--pkgs is required when pkgref is not running in an interactive terminal");
  }
  if (!packages.length) {
    stop("No dependencies found in package.json.");
  }
  const selected = await ask(
    multiselect({
      message: "Select packages to clone",
      options: packages.map((value) => ({ label: value, value })),
      required: false,
      maxItems: 10,
    }),
  );
  if (!selected.length) {
    stop("No packages selected.");
  }
  return selected;
}

async function confirmRepositories(repositories: RepositoryGroup[]) {
  note(
    repositories
      .map(({ name, packages, cloneUrl }) => `${name} (${packages.join(", ")})\n${cloneUrl}`)
      .join("\n\n"),
    "Git repositories",
  );
  const proceed = await confirmChoice(
    "Clone these Git repositories?",
    "Operation cancelled. No repositories were cloned.",
  );
  if (!proceed) {
    abort("Operation cancelled. No repositories were cloned.");
  }
}

const confirmChoice = (message: string, cancelMessage?: string) =>
  ask(confirm({ message, initialValue: true }), cancelMessage);

async function confirmUpdate(name: string) {
  const value = await confirm({
    message: `${name} already exists. Update it?`,
    initialValue: false,
  });
  if (isCancel(value)) {
    cancel("Update skipped.");
    return false;
  }
  return value;
}

async function ask<T>(answer: Promise<T | symbol>, message = "Operation cancelled.") {
  const value = await answer;
  if (isCancel(value)) {
    abort(message);
  }
  return value as T;
}

function abort(message: string): never {
  cancel(message);
  throw CANCELLED;
}

function stop(message: string): never {
  console.log(message);
  throw CANCELLED;
}

async function addAgentsReference(cwd: string, indexPath: string) {
  const path = join(cwd, "AGENTS.md");
  const link = relative(cwd, indexPath).split(sep).map(encodeURIComponent).join("/");
  await writeFile(path, renderAgentsReference((await readOptional(path)) ?? "", link));
  console.log(`Updated ${path}`);
}

async function git(args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, encoding: "utf8" });
    return { ok: true, output: (stderr || stdout).trim() };
  } catch (error) {
    const result = error as Error & { stderr?: string; stdout?: string };
    return {
      ok: false,
      output: (result.stderr || result.stdout || result.message).trim(),
    };
  }
}

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.filename === realpathSync(process.argv[1])) {
  process.exitCode = await runCli();
}
