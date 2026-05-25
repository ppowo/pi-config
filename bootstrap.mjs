#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = resolve(homedir());
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(HOME, ".pi", "agent");
const EXTENSIONS_DIR = join(REPO_DIR, "extensions");
const PI_EXTENSIONS_DIR = join(PI_DIR, "extensions");
const THEMES_DIR = join(REPO_DIR, "themes");
const PI_THEMES_DIR = join(PI_DIR, "themes");

const links = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
  { link: join(PI_DIR, "skills"), target: join(REPO_DIR, "skills") },
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
const WEB_TOOLS_OVERLAY = join(REPO_DIR, "web-tools.json");
const PI_WEB_TOOLS = join(HOME, ".pi", "web-tools.json");
const PI_WEB_TOOLS_OWNED_STATE = join(PI_DIR, ".web-tools-overlay-owned-paths.json");
const HASHLINE_READMAP_OVERLAY = join(REPO_DIR, "hashline-readmap-settings.json");
const PI_HASHLINE_READMAP_SETTINGS = join(PI_DIR, "hashline-readmap", "settings.json");
const PI_HASHLINE_READMAP_OWNED_STATE = join(PI_DIR, ".hashline-readmap-overlay-owned-paths.json");
const QUOTAS_OVERLAY = join(REPO_DIR, "quotas.json");
const PI_QUOTAS = join(PI_EXTENSIONS_DIR, "quotas.json");
const PI_QUOTAS_OWNED_STATE = join(PI_DIR, ".quotas-overlay-owned-paths.json");
const RESETTABLE_PI_PATHS = [
  // Fully managed by this repo. settings.json/verbosity.json stay incremental.
  ...links.map(({link}) => link),
  PI_EXTENSIONS_DIR,
  PI_THEMES_DIR,
  join(PI_DIR, ".managed-extension-entry-names.json"),
  join(PI_DIR, ".managed-local-packages.json"),
];


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
  await rm(linkPath, { recursive: true, force: true });

  if (!existsSync(targetPath)) {
    console.log(`skip ${linkPath}: target does not exist`);
    return;
  }

  const targetLooksLikeFile = /\.[^/\\]+$/.test(targetPath);

  if (process.platform === "win32" && targetLooksLikeFile) {
    await mkdir(dirname(targetPath), { recursive: true });
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

async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
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

async function readJsonFile(path, fallback, options = {}) {
  if (!existsSync(path)) {
    return fallback;
  }

  if (options.removeSymbolicLink) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      await rm(path, { force: true });
      return fallback;
    }
  }

  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJsonFile(path, value) {
  assertSafePath(path, [HOME]);
  await ensureParentDir(path);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function cleanupManagedPiPaths() {
  for (const managedPath of RESETTABLE_PI_PATHS) {
    assertSafePath(managedPath, [PI_DIR]);
    await rm(managedPath, {recursive: true, force: true});
  }

  console.log("cleaned fully managed pi paths");
}

async function syncExtensionLinks() {
  assertSafePath(PI_EXTENSIONS_DIR, [PI_DIR]);

  if (existsSync(PI_EXTENSIONS_DIR)) {
    const stat = await lstat(PI_EXTENSIONS_DIR);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(PI_EXTENSIONS_DIR, { recursive: true, force: true });
    }
  }

  await mkdir(PI_EXTENSIONS_DIR, { recursive: true });

  const repoEntries = existsSync(EXTENSIONS_DIR)
    ? (await readdir(EXTENSIONS_DIR, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  for (const entry of repoEntries) {
    await relink(join(PI_EXTENSIONS_DIR, entry.name), join(EXTENSIONS_DIR, entry.name));
  }
}

async function syncThemeLinks() {
  assertSafePath(PI_THEMES_DIR, [PI_DIR]);

  if (existsSync(PI_THEMES_DIR)) {
    const stat = await lstat(PI_THEMES_DIR);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(PI_THEMES_DIR, { recursive: true, force: true });
    }
  }

  await mkdir(PI_THEMES_DIR, { recursive: true });

  const repoEntries = existsSync(THEMES_DIR)
    ? (await readdir(THEMES_DIR, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  for (const entry of repoEntries) {
    if (entry.name === "github-colorblind.json") continue;
    await relink(join(PI_THEMES_DIR, entry.name), join(THEMES_DIR, entry.name));
  }
}

async function mergeJsonOverlay(
  overlayPath,
  targetPath,
  ownedStatePath,
  label = "settings overlay",
) {
  const overlayExists = existsSync(overlayPath);
  const previousOwnedPaths = uniqueSorted(await readJsonFile(ownedStatePath, []));
  const existing = await readJsonFile(targetPath, {}, { removeSymbolicLink: true });

  if (!overlayExists) {
    if (previousOwnedPaths.length === 0) {
      console.log(`skip ${label}: overlay not found at ${overlayPath}`);
      return;
    }

    const cleaned = { ...existing };
    for (const key of previousOwnedPaths) {
      deletePathValue(cleaned, key.split(".").filter(Boolean));
    }

    await writeJsonFile(targetPath, cleaned);
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

  await writeJsonFile(targetPath, merged);

  if (currentOwnedPaths.length > 0) {
    await writeJsonFile(ownedStatePath, currentOwnedPaths);
  } else {
    await rm(ownedStatePath, { force: true });
  }

  console.log(`merged ${label} into ${targetPath}`);
}



function getThemeVariantFromArgs(args = process.argv.slice(2)) {
  if (args.includes("--dark")) {
    return "dark";
  }

  if (args.includes("--light")) {
    return "light";
  }

  return "light";
}

async function switchTheme(variant = getThemeVariantFromArgs()) {
  const themeDir = PI_THEMES_DIR;
  const linkPath = join(themeDir, "github-colorblind.json");
  const targetPath = join(themeDir, "github-colorblind", `${variant}.json`);
  const symlinkTarget = relative(dirname(linkPath), targetPath);

  try { await rm(linkPath, { force: true }); } catch {}
  await symlink(symlinkTarget, linkPath);
  console.log(`linked theme (${variant}): github-colorblind.json → ${symlinkTarget}`);
}

async function main() {
  if (!existsSync(PI_DIR)) {
    await mkdir(PI_DIR, { recursive: true });
  }

  await cleanupManagedPiPaths();

  for (const { link, target } of links) {
    await relink(link, target);
  }

  await syncExtensionLinks();
  await syncThemeLinks();

  await mergeJsonOverlay(QUOTAS_OVERLAY, PI_QUOTAS, PI_QUOTAS_OWNED_STATE, "pi-quotas settings overlay");
  await mergeJsonOverlay(SETTINGS_OVERLAY, PI_SETTINGS, PI_SETTINGS_OWNED_STATE, "pi settings overlay");
  await mergeJsonOverlay(VERBOSITY_OVERLAY, PI_VERBOSITY, PI_VERBOSITY_OWNED_STATE, "pi verbosity overlay");
  await mergeJsonOverlay(WEB_TOOLS_OVERLAY, PI_WEB_TOOLS, PI_WEB_TOOLS_OWNED_STATE, "pi web-tools overlay");
  await mergeJsonOverlay(HASHLINE_READMAP_OVERLAY, PI_HASHLINE_READMAP_SETTINGS, PI_HASHLINE_READMAP_OWNED_STATE, "hashline-readmap settings overlay");
  console.log("bootstrap complete");
  await switchTheme();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});