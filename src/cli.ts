#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
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
  type IndexRepository,
  type RegistryPackage,
  type RepositoryGroup,
} from "./core.ts";

interface CliOptions {
  cwd: string;
  directory?: string;
  packages?: string;
}

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface ProcessedRepository {
  index?: IndexRepository;
  failed: boolean;
}

const HELP = `pkgref - clone package source references

Usage:
  pkgref [--pkgs=<name,...>] [--dir=<path>]
  pkgref update [--dir=<path>]
  pkgref --help
  pkgref --version

Options:
  --pkgs  Comma-separated packages. Undeclared packages are allowed with a warning.
  --dir   Target directory (default: docs/pkg-reference).
  --help  Show this help.
  --version  Show the installed version.

Commands:
  update  Fast-forward all cloned repositories to their latest upstream revision.
`;

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let values: {
    dir?: string;
    help?: boolean;
    pkgs?: string;
    version?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        help: { type: "boolean", short: "h" },
        pkgs: { type: "string" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    console.error("Run pkgref --help for usage.");
    return 1;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(packageJson.version);
    return 0;
  }

  try {
    if (positionals.length > 1 || (positionals[0] && positionals[0] !== "update")) {
      throw new Error(`unknown command: ${positionals.join(" ")}`);
    }
    if (positionals[0] === "update") {
      if (values.pkgs !== undefined) {
        throw new Error("--pkgs cannot be used with the update command");
      }
      return await updateRepositories(cwd, values.dir);
    }

    return await execute({
      cwd,
      directory: values.dir,
      packages: values.pkgs,
    });
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

async function updateRepositories(cwd: string, directory?: string): Promise<number> {
  const targetRoot = resolve(cwd, directory ?? "docs/pkg-reference");
  if (!(await pathExists(targetRoot))) {
    console.log(`No package reference directory found at ${targetRoot}.`);
    return 0;
  }

  const entries = await readdir(targetRoot, { withFileTypes: true });
  const repositories: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && (await pathExists(join(targetRoot, entry.name, ".git")))) {
      repositories.push(entry.name);
    }
  }

  if (repositories.length === 0) {
    console.log(`No cloned repositories found in ${targetRoot}.`);
    return 0;
  }

  let failed = false;
  let updated = 0;
  for (const repository of repositories) {
    const repositoryRoot = join(targetRoot, repository);
    const status = await runCommand("git", ["-C", repositoryRoot, "status", "--porcelain"]);
    if (status.code !== 0) {
      console.error(`Failed to inspect ${repository}: ${commandError(status)}`);
      failed = true;
      continue;
    }
    if (status.stdout.trim()) {
      console.warn(`Skipped ${repository}: the worktree has local changes.`);
      failed = true;
      continue;
    }

    console.log(`Updating ${repository}...`);
    const pull = await runCommand("git", ["-C", repositoryRoot, "pull", "--ff-only", "--prune"]);
    if (pull.code !== 0) {
      console.error(`Failed to update ${repository}: ${commandError(pull)}`);
      failed = true;
      continue;
    }
    updated += 1;
    console.log(`Updated ${repository}.`);
  }

  console.log(
    `Finished: ${updated} of ${repositories.length} repositories updated${failed ? " with errors" : ""}.`,
  );
  return failed ? 1 : 0;
}

async function execute(options: CliOptions): Promise<number> {
  const manifestPath = join(options.cwd, "package.json");
  const manifest = await readManifest(manifestPath);
  const declaredPackages = discoverDependencies(manifest);
  const interactive = options.packages === undefined;
  let selectedPackages: string[];
  let addReferenceToAgents = false;
  let targetDirectory = options.directory;

  if (!interactive) {
    // `interactive` guarantees this value is present.
    const packageArgument = options.packages ?? "";
    selectedPackages = parsePackageList(packageArgument);
    if (selectedPackages.length === 0) {
      throw new Error("--pkgs must contain at least one package name");
    }
    const declared = new Set(declaredPackages);
    for (const packageName of selectedPackages) {
      if (!declared.has(packageName)) {
        console.warn(
          `Warning: "${packageName}" is not declared in ${manifestPath}; resolving it anyway.`,
        );
      }
    }
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("--pkgs is required when pkgref is not running in an interactive terminal");
    }
    if (declaredPackages.length === 0) {
      console.log("No dependencies found in package.json.");
      return 0;
    }
    const selection = await promptForPackages(declaredPackages);
    if (selection === null) {
      return 0;
    }
    selectedPackages = selection;
    if (selectedPackages.length === 0) {
      console.log("No packages selected.");
      return 0;
    }
  }

  const resolutionResults = await Promise.all(
    selectedPackages.map(async (name) => {
      try {
        return { name, repository: await resolvePackageRepository(name) };
      } catch (error) {
        console.error(`Failed to resolve ${name}: ${errorMessage(error)}`);
        return { name, error: true as const };
      }
    }),
  );
  const resolved = resolutionResults.filter(
    (
      result,
    ): result is {
      name: string;
      repository: ReturnType<typeof normalizeRepository>;
    } => "repository" in result,
  );
  let failed = resolved.length !== selectedPackages.length;

  const groups = groupRepositories(resolved);
  if (groups.length === 0) {
    return failed ? 1 : 0;
  }

  if (interactive) {
    const confirmed = await promptForRepositoryConfirmation(groups);
    if (!confirmed) {
      return 0;
    }

    if (targetDirectory === undefined) {
      const directory = await promptForTargetDirectory();
      if (directory === null) {
        return 0;
      }
      targetDirectory = directory;
    }

    const addReference = await promptForAgentsReference();
    if (addReference === null) {
      return 0;
    }
    addReferenceToAgents = addReference;
  }

  const targetRoot = resolve(options.cwd, targetDirectory ?? "docs/pkg-reference");
  const indexPath = join(targetRoot, "INDEX.md");
  const existingIndex = await readOwnedIndex(indexPath);
  await mkdir(targetRoot, { recursive: true });

  const indexRepositories: IndexRepository[] = [];
  for (const group of groups) {
    const processed = await processRepository(group, targetRoot);
    failed ||= processed.failed;
    if (processed.index) {
      indexRepositories.push(processed.index);
    }
  }

  const generatedIndex = await renderIndex(indexRepositories, targetRoot);
  const index = existingIndex ? mergeIndexes(existingIndex, generatedIndex) : generatedIndex;
  await writeFile(indexPath, index, "utf8");
  console.log(`Wrote ${indexPath}`);
  if (addReferenceToAgents) {
    await addAgentsReference(options.cwd, indexPath);
  }
  console.log(
    `Finished: ${indexRepositories.length} repositories indexed, ${failed ? "with errors" : "successfully"}.`,
  );
  return failed ? 1 : 0;
}

async function resolvePackageRepository(packageName: string) {
  const encodedName = encodeURIComponent(packageName);
  const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} ${response.statusText}`);
  }
  return repositoryFromMetadata((await response.json()) as RegistryPackage);
}

async function processRepository(
  group: RepositoryGroup,
  targetRoot: string,
): Promise<ProcessedRepository> {
  const destination = join(targetRoot, group.name);

  if (!(await pathExists(destination))) {
    console.log(`Cloning ${group.name} (${group.packages.join(", ")})...`);
    const result = await runCommand("git", [
      "clone",
      "--depth",
      "1",
      "--",
      group.cloneUrl,
      destination,
    ]);
    if (result.code !== 0) {
      await removeFailedClone(destination);
      console.error(`Failed to clone ${group.name}: ${commandError(result)}`);
      return { failed: true };
    }
    return {
      failed: false,
      index: { directory: group.name, packages: group.packages, root: destination },
    };
  }

  const validClone = await validateExistingClone(destination, group);
  if (!validClone.valid) {
    console.warn(`Skipping ${group.name}: ${validClone.reason}`);
    return { failed: false };
  }

  let update = false;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    update = await promptForUpdate(group.name);
  }
  if (update) {
    const status = await runCommand("git", ["-C", destination, "status", "--porcelain"]);
    if (status.code !== 0) {
      console.warn(`Skipping update for ${group.name}: ${commandError(status)}`);
      return {
        failed: true,
        index: { directory: group.name, packages: group.packages, root: destination },
      };
    } else if (status.stdout.trim()) {
      console.warn(`Skipping update for ${group.name}: the worktree has local changes.`);
    } else {
      const pull = await runCommand("git", ["-C", destination, "pull", "--ff-only"]);
      if (pull.code !== 0) {
        console.error(`Failed to update ${group.name}: ${commandError(pull)}`);
        return {
          failed: true,
          index: { directory: group.name, packages: group.packages, root: destination },
        };
      }
      console.log(`Updated ${group.name}.`);
    }
  } else {
    console.log(`Skipped update for ${group.name}.`);
  }

  return {
    failed: false,
    index: { directory: group.name, packages: group.packages, root: destination },
  };
}

async function validateExistingClone(
  destination: string,
  expected: RepositoryGroup,
): Promise<{ reason?: string; valid: boolean }> {
  const directoryStat = await stat(destination);
  if (!directoryStat.isDirectory()) {
    return { valid: false, reason: "the destination exists and is not a directory" };
  }

  const origin = await runCommand("git", ["-C", destination, "remote", "get-url", "origin"]);
  if (origin.code !== 0) {
    return { valid: false, reason: "the destination is not a Git clone with an origin" };
  }

  try {
    const actual = normalizeRepository(origin.stdout.trim());
    if (actual.key !== expected.key) {
      return { valid: false, reason: "the existing clone has a different origin" };
    }
  } catch (error) {
    return { valid: false, reason: `cannot read its origin: ${errorMessage(error)}` };
  }

  return { valid: true };
}

async function readOwnedIndex(indexPath: string): Promise<string | undefined> {
  if (!(await pathExists(indexPath))) {
    return undefined;
  }
  const contents = await readFile(indexPath, "utf8");
  if (!contents.startsWith(INDEX_MARKER)) {
    throw new Error(`refusing to overwrite user-owned index at ${indexPath}`);
  }
  return contents;
}

async function promptForPackages(packages: string[]): Promise<string[] | null> {
  const selection = await multiselect({
    message: "Select packages to clone",
    options: packages.map((packageName) => ({
      label: packageName,
      value: packageName,
    })),
    required: false,
    maxItems: 10,
  });

  if (isCancel(selection)) {
    cancel("Operation cancelled.");
    return null;
  }

  return selection;
}

async function promptForUpdate(repository: string): Promise<boolean> {
  const update = await confirm({
    message: `${repository} already exists. Update it?`,
    initialValue: false,
  });

  if (isCancel(update)) {
    cancel("Update skipped.");
    return false;
  }

  return update;
}

async function promptForTargetDirectory(): Promise<string | null> {
  const directory = await text({
    message: "Where should package references be stored?",
    initialValue: "docs/pkg-reference",
    validate(value) {
      if (!value?.trim()) {
        return "Target directory is required.";
      }
    },
  });

  if (isCancel(directory)) {
    cancel("Operation cancelled.");
    return null;
  }

  return directory.trim();
}

async function promptForRepositoryConfirmation(repositories: RepositoryGroup[]): Promise<boolean> {
  note(
    repositories
      .map(
        (repository) =>
          `${repository.name} (${repository.packages.join(", ")})\n${repository.cloneUrl}`,
      )
      .join("\n\n"),
    "Git repositories",
  );
  const proceed = await confirm({
    message: "Clone these Git repositories?",
    initialValue: true,
  });

  if (isCancel(proceed) || !proceed) {
    cancel("Operation cancelled. No repositories were cloned.");
    return false;
  }

  return true;
}

async function promptForAgentsReference(): Promise<boolean | null> {
  const addReference = await confirm({
    message: "Add the package reference index to AGENTS.md?",
    initialValue: true,
  });

  if (isCancel(addReference)) {
    cancel("Operation cancelled.");
    return null;
  }

  return addReference;
}

async function addAgentsReference(cwd: string, indexPath: string): Promise<void> {
  const agentsPath = join(cwd, "AGENTS.md");
  const contents = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
  const relativeIndexPath = relative(cwd, indexPath)
    .split(sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  await writeFile(agentsPath, renderAgentsReference(contents, relativeIndexPath), "utf8");
  console.log(`Updated ${agentsPath}`);
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveCommand({ code: code ?? 1, stderr, stdout });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeFailedClone(destination: string): Promise<void> {
  if (await pathExists(join(destination, ".git"))) {
    await rm(destination, { force: true, recursive: true });
  }
}

function commandError(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}
