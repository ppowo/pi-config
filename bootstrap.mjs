#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
const VERBOSITY_OVERLAY = join(REPO_DIR, "verbosity.json");
const PI_VERBOSITY = join(PI_DIR, "verbosity.json");
const WEB_TOOLS_OVERLAY = join(REPO_DIR, "web-tools.json");
const PI_WEB_TOOLS = join(HOME, ".pi", "web-tools.json");
const HASHLINE_READMAP_OVERLAY = join(REPO_DIR, "hashline-readmap-settings.json");
const PI_HASHLINE_READMAP_SETTINGS = join(PI_DIR, "hashline-readmap", "settings.json");
const QUOTAS_OVERLAY = join(REPO_DIR, "quotas.json");
const NEURALWATT_OVERLAY = join(REPO_DIR, "neuralwatt.json");
const PI_QUOTAS = join(PI_EXTENSIONS_DIR, "quotas.json");
const PI_NEURALWATT = join(PI_EXTENSIONS_DIR, "neuralwatt.json");
const PI_VCC_CONFIG_OVERLAY = join(REPO_DIR, "pi-vcc-config.json");
const PI_VCC_CONFIG = join(PI_DIR, "pi-vcc-config.json");
const RESETTABLE_PI_PATHS = [
  // Fully managed by this repo.
  ...links.map(({link}) => link),
  PI_EXTENSIONS_DIR,
  PI_THEMES_DIR,
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

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeManagedJsonFile(path, value) {
  assertSafePath(path, [HOME]);
  await ensureParentDir(path);
  await rm(path, { recursive: true, force: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function installJsonConfig(sourcePath, targetPath, label) {
  assertSafePath(targetPath, [HOME]);
  if (!existsSync(sourcePath)) {
    await rm(targetPath, { recursive: true, force: true });
    console.log(`removed ${label}: source not found at ${sourcePath}`);
    return;
  }

  const value = await readJsonFile(sourcePath);
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object: ${sourcePath}`);
  }

  await writeManagedJsonFile(targetPath, value);
  console.log(`wrote ${label} to ${targetPath}`);
}

async function cleanupManagedPiPaths() {
  for (const managedPath of RESETTABLE_PI_PATHS) {
    assertSafePath(managedPath, [PI_DIR]);
    await rm(managedPath, {recursive: true, force: true});
  }

  console.log("cleaned fully managed pi paths");
}

async function syncDirectoryLinks(sourceDir, targetDir) {
  assertSafePath(targetDir, [PI_DIR]);
  await mkdir(targetDir, { recursive: true });

  const repoEntries = existsSync(sourceDir)
    ? (await readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  for (const entry of repoEntries) {
    await relink(join(targetDir, entry.name), join(sourceDir, entry.name));
  }
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

  await syncDirectoryLinks(EXTENSIONS_DIR, PI_EXTENSIONS_DIR);
  await syncDirectoryLinks(THEMES_DIR, PI_THEMES_DIR);

  await installJsonConfig(QUOTAS_OVERLAY, PI_QUOTAS, "pi-quotas settings");
  await installJsonConfig(NEURALWATT_OVERLAY, PI_NEURALWATT, "neuralwatt settings");
  await installJsonConfig(PI_VCC_CONFIG_OVERLAY, PI_VCC_CONFIG, "pi-vcc config");
  await installJsonConfig(SETTINGS_OVERLAY, PI_SETTINGS, "pi settings");
  await installJsonConfig(VERBOSITY_OVERLAY, PI_VERBOSITY, "pi verbosity");
  await installJsonConfig(WEB_TOOLS_OVERLAY, PI_WEB_TOOLS, "pi web-tools");
  await installJsonConfig(HASHLINE_READMAP_OVERLAY, PI_HASHLINE_READMAP_SETTINGS, "hashline-readmap settings");
  console.log("bootstrap complete");
  await switchTheme();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});