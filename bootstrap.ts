#!/usr/bin/env bun
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const REPO_DIR = process.cwd();
const PI_DIR = join(HOME, ".pi", "agent");

const links: Array<{ link: string; target: string }> = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
  { link: join(PI_DIR, "extensions"), target: join(REPO_DIR, "extensions") },
  { link: join(PI_DIR, "themes"), target: join(REPO_DIR, "themes") },
  { link: join(PI_DIR, "APPEND_SYSTEM.md"), target: join(REPO_DIR, "APPEND_SYSTEM.md") },
];

const SETTINGS_OVERLAY = join(REPO_DIR, "settings.json");
const PI_SETTINGS = join(PI_DIR, "settings.json");
const PI_SETTINGS_OWNED_KEYS = ["theme", "packages", "compaction"];

const SUB_BAR_SETTINGS_OVERLAY = join(REPO_DIR, "sub-bar-settings.json");
const PI_SUB_BAR_SETTINGS = join(PI_DIR, "pi-sub-bar-settings.json");
const SUB_BAR_SETTINGS_OWNED_KEYS = ["display", "displayThemes", "displayUserTheme"];

function assertSafePath(path: string) {
  const blocked = ["/", HOME, join(HOME, ".pi"), join(HOME, ".pi", "agent")];
  if (blocked.includes(path)) {
    throw new Error(`Refusing unsafe path removal: ${path}`);
  }
  if (!path.startsWith(HOME + "/")) {
    throw new Error(`Refusing removal outside home directory: ${path}`);
  }
}

async function relink(linkPath: string, targetPath: string) {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
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

async function mergeJsonOverlay(
  overlayPath: string,
  targetPath: string,
  ownedKeys: string[] = [],
  label = "settings overlay",
) {
  if (!existsSync(overlayPath)) {
    console.log(`skip ${label}: overlay not found at ${overlayPath}`);
    return;
  }

  const overlay = JSON.parse(await readFile(overlayPath, "utf-8")) as Record<string, unknown>;

  let existing: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    // If it's a symlink (from a previous bootstrap), remove it first
    const stat = await import("node:fs/promises").then((m) => m.lstat(targetPath));
    if (stat.isSymbolicLink()) {
      await rm(targetPath, { force: true });
    } else {
      existing = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
    }
  }

  const merged = deepMerge(existing, overlay);
  for (const key of ownedKeys) {
    if (key in overlay) {
      merged[key] = overlay[key];
    } else {
      delete merged[key];
    }
  }

  await writeFile(targetPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`merged ${label} into ${targetPath}`);
}

async function main() {
  if (!existsSync(PI_DIR)) {
    await mkdir(PI_DIR, { recursive: true });
  }

  for (const { link, target } of links) {
    await relink(link, target);
  }

  // Merge settings overlay into pi's settings (instead of symlinking)
  await mergeJsonOverlay(SETTINGS_OVERLAY, PI_SETTINGS, PI_SETTINGS_OWNED_KEYS, "pi settings overlay");

  // Merge sub-bar theme display settings (if present)
  await mergeJsonOverlay(
    SUB_BAR_SETTINGS_OVERLAY,
    PI_SUB_BAR_SETTINGS,
    SUB_BAR_SETTINGS_OWNED_KEYS,
    "sub-bar settings overlay",
  );

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
