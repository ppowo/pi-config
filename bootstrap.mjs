#!/usr/bin/env node
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(HOME, ".pi", "agent");

const links = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
  { link: join(PI_DIR, "extensions"), target: join(REPO_DIR, "extensions") },
  { link: join(PI_DIR, "skills"), target: join(REPO_DIR, "skills") },
  { link: join(PI_DIR, "themes"), target: join(REPO_DIR, "themes") },
  { link: join(PI_DIR, "APPEND_SYSTEM.md"), target: join(REPO_DIR, "APPEND_SYSTEM.md") },
  { link: join(PI_DIR, "models.json"), target: join(REPO_DIR, "models.json") },
];

const SETTINGS_OVERLAY = join(REPO_DIR, "settings.json");
const PI_SETTINGS = join(PI_DIR, "settings.json");
const PI_SETTINGS_OWNED_STATE = join(PI_DIR, ".settings-overlay-owned-paths.json");

function assertSafePath(path) {
  const blocked = ["/", HOME, join(HOME, ".pi"), join(HOME, ".pi", "agent")];
  if (blocked.includes(path)) {
    throw new Error(`Refusing unsafe path removal: ${path}`);
  }
  if (!path.startsWith(HOME + "/")) {
    throw new Error(`Refusing removal outside home directory: ${path}`);
  }
}

async function relink(linkPath, targetPath) {
  assertSafePath(linkPath);

  await mkdir(dirname(linkPath), { recursive: true });

  // Ensure target directory exists only when target is a directory path.
  // For files (e.g. settings.json), parent directory is enough.
  const targetLooksLikeFile = /\.[^/]+$/.test(targetPath);
  if (targetLooksLikeFile) {
    await mkdir(dirname(targetPath), { recursive: true });
  } else {
    await mkdir(targetPath, { recursive: true });
  }

  await rm(linkPath, { recursive: true, force: true });
  await symlink(targetPath, linkPath);

  console.log(`linked ${linkPath} -> ${targetPath}`);
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

  // Remove empty containers left behind by nested deletes.
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

  // Track repo-managed settings by leaf path.
  //
  // Why leaf paths instead of whole top-level keys?
  // - `theme`, `spinnerVerbs`, and `packages` are fully owned because they are leaves.
  // - Nested settings such as `compaction.enabled` are owned precisely, so unrelated
  //   local keys like `compaction.reserveTokens` stay intact.
  // - A small state file remembers previously owned leaf paths so removing a repo-
  //   managed key from settings.json also removes it from ~/.pi/agent/settings.json
  //   on the next bootstrap run.
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

async function main() {
  if (!existsSync(PI_DIR)) {
    await mkdir(PI_DIR, { recursive: true });
  }

  for (const { link, target } of links) {
    await relink(link, target);
  }

  // Merge settings overlay into pi's settings (instead of symlinking).
  await mergeJsonOverlay(SETTINGS_OVERLAY, PI_SETTINGS, PI_SETTINGS_OWNED_STATE, "pi settings overlay");

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
