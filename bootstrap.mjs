#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = resolve(homedir());
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(HOME, ".pi", "agent");
const EXTENSIONS_DIR = join(REPO_DIR, "extensions");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

const links = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
  { link: join(PI_DIR, "extensions"), target: join(REPO_DIR, "extensions") },
  { link: join(PI_DIR, "skills"), target: join(REPO_DIR, "skills") },
  { link: join(PI_DIR, "themes"), target: join(REPO_DIR, "themes") },
  { link: join(PI_DIR, "reminders"), target: join(REPO_DIR, "reminders") },
  { link: join(PI_DIR, "APPEND_SYSTEM.md"), target: join(REPO_DIR, "APPEND_SYSTEM.md") },
  { link: join(PI_DIR, "models.json"), target: join(REPO_DIR, "models.json") },
];

const SETTINGS_OVERLAY = join(REPO_DIR, "settings.json");
const PI_SETTINGS = join(PI_DIR, "settings.json");
const PI_SETTINGS_OWNED_STATE = join(PI_DIR, ".settings-overlay-owned-paths.json");
const VERBOSITY_OVERLAY = join(REPO_DIR, "verbosity.json");
const PI_VERBOSITY = join(PI_DIR, "verbosity.json");
const PI_VERBOSITY_OWNED_STATE = join(PI_DIR, ".verbosity-overlay-owned-paths.json");
const LOCAL_PACKAGES_STATE = join(PI_DIR, ".managed-local-packages.json");
const PI_NUSHELL_DIR = join(HOME, ".config", "pi", "nushell");
const PI_NUSHELL_CONFIG = join(PI_NUSHELL_DIR, "config.nu");
const PI_NUSHELL_PLUGIN_REGISTRY = join(PI_NUSHELL_DIR, "plugins.msgpackz");
const OPTIONAL_NUSHELL_PLUGINS = [
  { name: "gstat", binary: "nu_plugin_gstat" },
  { name: "query", binary: "nu_plugin_query" },
  { name: "formats", binary: "nu_plugin_formats" },
  { name: "semver", binary: "nu_plugin_semver" },
  { name: "file", binary: "nu_plugin_file" },
];

function normalizeRelPath(path) {
  return path.replaceAll("\\", "/");
}

function repoPathFromRel(relPath) {
  return join(REPO_DIR, ...relPath.split("/"));
}

function pathIsInside(root, targetPath) {
  const rel = relative(root, targetPath);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

function assertSafePath(path, allowedRoots = [HOME]) {
  const resolvedPath = resolve(path);
  const blocked = [resolve("/"), HOME, join(HOME, ".pi"), PI_DIR, REPO_DIR, EXTENSIONS_DIR].map((value) => resolve(value));

  if (blocked.includes(resolvedPath)) {
    throw new Error(`Refusing unsafe path removal: ${path}`);
  }

  if (!allowedRoots.some((root) => pathIsInside(resolve(root), resolvedPath))) {
    throw new Error(`Refusing removal outside managed roots: ${path}`);
  }
}

async function relink(linkPath, targetPath) {
  assertSafePath(linkPath, [HOME]);

  await mkdir(dirname(linkPath), { recursive: true });

  const targetLooksLikeFile = /\.[^/\\]+$/.test(targetPath);
  if (targetLooksLikeFile) {
    await mkdir(dirname(targetPath), { recursive: true });
  } else {
    await mkdir(targetPath, { recursive: true });
  }

  await rm(linkPath, { recursive: true, force: true });

  if (process.platform === "win32" && targetLooksLikeFile) {
    await copyFile(targetPath, linkPath);
    console.log(`copied ${targetPath} -> ${linkPath}`);
    return;
  }

  const symlinkTarget = process.platform === "win32" ? resolve(targetPath) : targetPath;
  const symlinkType = process.platform === "win32"
    ? (targetLooksLikeFile ? "file" : "junction")
    : (targetLooksLikeFile ? "file" : "dir");

  await symlink(symlinkTarget, linkPath, symlinkType);

  console.log(`linked ${linkPath} -> ${targetPath}`);
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quoteNuString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function writeManagedFile(path, content) {
  assertSafePath(path, [HOME]);
  await mkdir(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const stat = await lstat(path);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true });
    }
  }

  await writeFile(path, content);
}

async function capture(command, args, cwd, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        rejectPromise(new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${detail}`));
      }
    });
  });
}

async function resolveCommandPath(commandName) {
  if (process.platform === "win32") {
    try {
      const output = await capture("where", [commandName], REPO_DIR);
      return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
    } catch {
      return null;
    }
  }

  try {
    const output = await capture("/bin/sh", ["-lc", `command -v ${quoteForPosixShell(commandName)}`], REPO_DIR);
    const resolvedPath = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!resolvedPath) {
      return null;
    }
    return isAbsolute(resolvedPath) ? resolvedPath : resolve(REPO_DIR, resolvedPath);
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (isObject(sourceValue) && isObject(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

function getPathValue(source, path) {
  let current = source;

  for (const segment of path) {
    if (!isObject(current)) {
      return { found: false };
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }

    current = current[segment];
  }

  return { found: true, value: current };
}

function setPathValue(target, path, value) {
  if (path.length === 0) {
    return;
  }

  let current = target;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = current[segment];

    if (!isObject(next)) {
      current[segment] = {};
    }

    current = current[segment];
  }

  current[path[path.length - 1]] = value;
}

function deletePathValue(target, path) {
  if (path.length === 0) {
    return;
  }

  const trail = [];
  let current = target;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = current[segment];

    if (!isObject(next)) {
      return;
    }

    trail.push({ parent: current, key: segment });
    current = next;
  }

  delete current[path[path.length - 1]];

  for (let i = trail.length - 1; i >= 0; i--) {
    const { parent, key } = trail[i];
    const child = parent[key];

    if (isObject(child) && Object.keys(child).length === 0) {
      delete parent[key];
      continue;
    }

    break;
  }
}

function collectLeafPaths(value, prefix = []) {
  if (!isObject(value)) {
    return prefix.length > 0 ? [prefix.join(".")] : [];
  }

  const paths = [];
  for (const key of Object.keys(value)) {
    paths.push(...collectLeafPaths(value[key], [...prefix, key]));
  }
  return paths;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function readJsonFile(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }

  return JSON.parse(await readFile(path, "utf-8"));
}

async function loadExistingJson(targetPath) {
  if (!existsSync(targetPath)) {
    return {};
  }

  const stat = await lstat(targetPath);
  if (stat.isSymbolicLink()) {
    await rm(targetPath, { force: true });
    return {};
  }

  return JSON.parse(await readFile(targetPath, "utf-8"));
}

async function mergeJsonOverlay(
  overlayPath,
  targetPath,
  ownedStatePath,
  label = "settings overlay",
) {
  const overlayExists = existsSync(overlayPath);
  const previousOwnedPaths = uniqueSorted(await readJsonFile(ownedStatePath, []));
  const existing = await loadExistingJson(targetPath);

  if (!overlayExists) {
    if (previousOwnedPaths.length === 0) {
      console.log(`skip ${label}: overlay not found at ${overlayPath}`);
      return;
    }

    const cleaned = { ...existing };
    for (const key of previousOwnedPaths) {
      deletePathValue(cleaned, key.split(".").filter(Boolean));
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify(cleaned, null, 2) + "\n");
    await rm(ownedStatePath, { force: true });
    console.log(`cleared ${label} managed keys from ${targetPath}`);
    return;
  }

  const overlay = await readJsonFile(overlayPath, {});
  if (!isObject(overlay)) {
    throw new Error(`${label} must be a JSON object: ${overlayPath}`);
  }

  const currentOwnedPaths = uniqueSorted(collectLeafPaths(overlay));
  const ownedPathsToApply = uniqueSorted([...previousOwnedPaths, ...currentOwnedPaths]);

  const merged = deepMerge(existing, overlay);

  for (const key of ownedPathsToApply) {
    const path = key.split(".").filter(Boolean);
    const { found, value } = getPathValue(overlay, path);

    if (found) {
      setPathValue(merged, path, value);
    } else {
      deletePathValue(merged, path);
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(merged, null, 2) + "\n");

  if (currentOwnedPaths.length > 0) {
    await writeFile(ownedStatePath, JSON.stringify(currentOwnedPaths, null, 2) + "\n");
  } else {
    await rm(ownedStatePath, { force: true });
  }

  console.log(`merged ${label} into ${targetPath}`);
}

function createLocalPackagesState(packages = {}) {
  return { packages };
}

async function readLocalPackagesState() {
  const raw = await readJsonFile(LOCAL_PACKAGES_STATE, createLocalPackagesState());
  if (!isObject(raw) || !isObject(raw.packages)) {
    return createLocalPackagesState();
  }

  const packages = {};
  for (const [relPath, meta] of Object.entries(raw.packages)) {
    if (isObject(meta) && typeof meta.fingerprint === "string") {
      packages[normalizeRelPath(relPath)] = { fingerprint: meta.fingerprint };
    }
  }
  return createLocalPackagesState(packages);
}

async function writeLocalPackagesState(state) {
  await mkdir(dirname(LOCAL_PACKAGES_STATE), { recursive: true });
  await writeFile(LOCAL_PACKAGES_STATE, JSON.stringify(state, null, 2) + "\n");
}

async function discoverLocalExtensionPackages() {
  if (!existsSync(EXTENSIONS_DIR)) {
    return [];
  }

  const entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(EXTENSIONS_DIR, entry.name);
    const packageJsonPath = join(dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    packages.push({
      dir,
      relPath: normalizeRelPath(relative(REPO_DIR, dir)),
      packageJsonPath,
      nodeModulesPath: join(dir, "node_modules"),
    });
  }

  return packages.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function fingerprintLocalPackage(pkg) {
  const hash = createHash("sha256");
  hash.update(await readFile(pkg.packageJsonPath, "utf-8"));
  return hash.digest("hex");
}

async function run(command, args, cwd, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed in ${cwd} with exit code ${code}`));
      }
    });
  });
}

async function installLocalPackageDependencies(pkg, previousFingerprint) {
  const fingerprintBeforeInstall = await fingerprintLocalPackage(pkg);
  const hasNodeModules = existsSync(pkg.nodeModulesPath);

  if (hasNodeModules && previousFingerprint === fingerprintBeforeInstall) {
    console.log(`local package unchanged, skipping install: ${pkg.relPath}`);
    return { relPath: pkg.relPath, fingerprint: fingerprintBeforeInstall };
  }

  const installArgs = ["install", "--no-audit", "--no-fund", "--package-lock=false"];
  const action = hasNodeModules ? "updating" : "installing";

  console.log(`${action} local package dependencies: ${pkg.relPath}`);
  await run(NPM_COMMAND, installArgs, pkg.dir);

  const fingerprintAfterInstall = await fingerprintLocalPackage(pkg);
  return { relPath: pkg.relPath, fingerprint: fingerprintAfterInstall };
}

async function cleanupRemovedLocalPackage(relPath) {
  const dir = repoPathFromRel(relPath);
  if (!existsSync(dir)) {
    console.log(`removed stale local package state: ${relPath}`);
    return;
  }

  const nodeModulesPath = join(dir, "node_modules");
  if (existsSync(nodeModulesPath)) {
    assertSafePath(nodeModulesPath, [REPO_DIR]);
    await rm(nodeModulesPath, { recursive: true, force: true });
    console.log(`removed stale node_modules for ${relPath}`);
  }

  const remainingEntries = existsSync(dir)
    ? (await readdir(dir)).filter((name) => name !== ".DS_Store")
    : [];

  if (remainingEntries.length === 0) {
    assertSafePath(dir, [REPO_DIR]);
    await rm(dir, { recursive: true, force: true });
    console.log(`removed empty stale package directory: ${relPath}`);
    return;
  }

  console.log(`left stale package directory intact (${relPath}); remaining entries: ${remainingEntries.join(", ")}`);
}

async function syncLocalExtensionPackages() {
  const packages = await discoverLocalExtensionPackages();
  const previousState = await readLocalPackagesState();
  const nextPackages = {};

  for (const pkg of packages) {
    const previousFingerprint = previousState.packages[pkg.relPath]?.fingerprint;
    const record = await installLocalPackageDependencies(pkg, previousFingerprint);
    nextPackages[record.relPath] = { fingerprint: record.fingerprint };
  }

  const previousPaths = new Set(Object.keys(previousState.packages));
  const currentPaths = new Set(packages.map((pkg) => pkg.relPath));
  const removedPaths = [...previousPaths]
    .filter((relPath) => !currentPaths.has(relPath))
    .sort((a, b) => a.localeCompare(b));

  for (const relPath of removedPaths) {
    await cleanupRemovedLocalPackage(relPath);
  }

  if (Object.keys(nextPackages).length === 0) {
    await rm(LOCAL_PACKAGES_STATE, { force: true });
    console.log("local extension package sync complete (no managed packages)");
    return;
  }

  await writeLocalPackagesState(createLocalPackagesState(nextPackages));
  console.log(`local extension package sync complete (${Object.keys(nextPackages).length} managed package(s))`);
}

async function syncPiNushellPlugins() {
  const nuPath = await resolveCommandPath("nu");
  if (!nuPath) {
    console.log("skip pi nushell bootstrap: nu not found in PATH");
    return;
  }

  await mkdir(PI_NUSHELL_DIR, { recursive: true });
  assertSafePath(PI_NUSHELL_PLUGIN_REGISTRY, [HOME]);
  await rm(PI_NUSHELL_PLUGIN_REGISTRY, { force: true });

  const discoveredPlugins = [];
  for (const plugin of OPTIONAL_NUSHELL_PLUGINS) {
    const binaryPath = await resolveCommandPath(plugin.binary);
    if (!binaryPath) {
      console.log(`skip optional nushell plugin (not found in PATH): ${plugin.binary}`);
      continue;
    }

    console.log(`registering pi nushell plugin: ${plugin.name} (${binaryPath})`);
    await run(
      nuPath,
      ["--no-config-file", "-c", "plugin add --plugin-config $env.PI_NUSHELL_PLUGIN_CONFIG $env.PI_NUSHELL_PLUGIN_BINARY"],
      REPO_DIR,
      {
        env: {
          PI_NUSHELL_PLUGIN_CONFIG: PI_NUSHELL_PLUGIN_REGISTRY,
          PI_NUSHELL_PLUGIN_BINARY: binaryPath,
        },
      },
    );

    discoveredPlugins.push({ ...plugin, binaryPath });
  }

  const configLines = [
    "# Generated by pi-config bootstrap.",
    `# Loads Nushell plugins from ${PI_NUSHELL_PLUGIN_REGISTRY}.`,
  ];

  for (const plugin of discoveredPlugins) {
    configLines.push(`plugin use --plugin-config ${quoteNuString(PI_NUSHELL_PLUGIN_REGISTRY)} ${plugin.name}`);
  }

  if (discoveredPlugins.length === 0) {
    configLines.push("# No optional Nushell plugins found on PATH during setup.");
  }

  await writeManagedFile(PI_NUSHELL_CONFIG, configLines.join("\n") + "\n");
  console.log(`wrote pi nushell config: ${PI_NUSHELL_CONFIG}`);
}

async function main() {
  if (!existsSync(PI_DIR)) {
    await mkdir(PI_DIR, { recursive: true });
  }

  for (const { link, target } of links) {
    await relink(link, target);
  }

  await mergeJsonOverlay(SETTINGS_OVERLAY, PI_SETTINGS, PI_SETTINGS_OWNED_STATE, "pi settings overlay");
  await mergeJsonOverlay(VERBOSITY_OVERLAY, PI_VERBOSITY, PI_VERBOSITY_OWNED_STATE, "pi verbosity overlay");
  await syncLocalExtensionPackages();
  await syncPiNushellPlugins();

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
