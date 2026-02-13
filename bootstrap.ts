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
];

const SETTINGS_OVERLAY = join(REPO_DIR, "settings.json");
const PI_SETTINGS = join(PI_DIR, "settings.json");

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

async function mergeSettings(overlayPath: string, targetPath: string) {
  const overlay = JSON.parse(await readFile(overlayPath, "utf-8"));

  let existing: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    // If it's a symlink (from a previous bootstrap), remove it first
    const stat = await import("node:fs/promises").then((m) => m.lstat(targetPath));
    if (stat.isSymbolicLink()) {
      await rm(targetPath, { force: true });
    } else {
      existing = JSON.parse(await readFile(targetPath, "utf-8"));
    }
  }

  const merged = { ...existing, ...overlay };
  await writeFile(targetPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`merged settings overlay into ${targetPath}`);
}

async function main() {
  if (!existsSync(PI_DIR)) {
    await mkdir(PI_DIR, { recursive: true });
  }

  for (const { link, target } of links) {
    await relink(link, target);
  }

  // Merge settings overlay into pi's settings (instead of symlinking)
  await mergeSettings(SETTINGS_OVERLAY, PI_SETTINGS);

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
