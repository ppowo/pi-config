#!/usr/bin/env node
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
const PI_EXTENSIONS_DIR = join(PI_DIR, "extensions");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ? resolve(process.env.XDG_DATA_HOME) : join(HOME, ".local", "share");
const DEFAULT_VEX_BIN_DIR = process.platform === "linux"
  ? join(XDG_DATA_HOME, "vex")
  : join(HOME, ".local", "share", "vex");
let vexBinDirPromise = null;

const links = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
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
const RESETTABLE_PI_PATHS = [
  // Fully managed by this repo. settings.json/verbosity.json stay incremental.
  ...links.map(({link}) => link),
  PI_EXTENSIONS_DIR,
  join(PI_DIR, ".managed-extension-entry-names.json"),
  join(PI_DIR, ".managed-local-packages.json"),
];
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

function summarizeWarningDetail(value, maxLength = 280) {
  const normalized = String(value ?? "unknown error").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function printHugeNushellPluginWarning(skippedPlugins) {
  if (skippedPlugins.length === 0) {
    return;
  }

  const border = "!".repeat(100);
  console.error("");
  console.error(border);
  console.error("!!! PI NUSHELL PLUGINS WERE SKIPPED DURING BOOTSTRAP !!!");
  console.error(border);
  console.error(`Skipped plugins: ${skippedPlugins.map(({ name }) => name).join(", ")}`);
  console.error(`Config written without them: ${PI_NUSHELL_CONFIG}`);
  console.error("Most likely cause: a Nushell/plugin version mismatch or a broken plugin binary.");
  console.error("If you manage Nushell with vex, fix the stack and rerun bootstrap:");
  console.error("  vex bin status nushell");
  console.error("  vex bin sync");
  console.error("");
  for (const plugin of skippedPlugins) {
    console.error(` - ${plugin.name} (${plugin.binary}): ${plugin.reason}`);
  }
  console.error(border);
  console.error("");
}

async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function writeManagedFile(path, content) {
  assertSafePath(path, [HOME]);
  await ensureParentDir(path);

  if (existsSync(path)) {
    const stat = await lstat(path);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true });
    }
  }

  await writeFile(path, content);
}

async function execCommand(command, args, cwd, options = {}) {
  const captureOutput = options.captureOutput !== false;

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    if (captureOutput) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });
    }

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(captureOutput ? stdout.trim() : "");
        return;
      }

      if (captureOutput) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        rejectPromise(new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${detail}`));
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} failed in ${cwd} with exit code ${code}`));
    });
  });
}

function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function resolveOutputPath(output, cwd = REPO_DIR) {
  const resolvedPath = firstNonEmptyLine(output);
  if (!resolvedPath) {
    return null;
  }

  return isAbsolute(resolvedPath) ? resolvedPath : resolve(cwd, resolvedPath);
}

function managedCommandFilename(commandName) {
  return process.platform === "win32" ? `${commandName}.exe` : commandName;
}

async function resolveVexBinDir() {
  if (!vexBinDirPromise) {
    vexBinDirPromise = (async () => {
      try {
        const output = await execCommand("vex", ["path"], REPO_DIR);
        const resolvedPath = resolveOutputPath(output);
        if (resolvedPath) {
          return resolvedPath;
        }
      } catch {
        // Fall back to the default managed bin location if vex is not callable here.
      }
      return DEFAULT_VEX_BIN_DIR;
    })();
  }

  return await vexBinDirPromise;
}

async function resolveManagedCommandPath(commandName) {
  const vexBinDir = await resolveVexBinDir();
  const directPath = join(vexBinDir, managedCommandFilename(commandName));
  if (existsSync(directPath)) {
    return directPath;
  }
  if (process.platform === "win32" && !commandName.toLowerCase().endsWith(".exe")) {
    const plainPath = join(vexBinDir, commandName);
    if (existsSync(plainPath)) {
      return plainPath;
    }
  }

  return null;
}

async function resolveCommandPath(commandName) {
  const managedPath = await resolveManagedCommandPath(commandName);
  if (managedPath) {
    return managedPath;
  }
  if (process.platform === "win32") {
    try {
      const output = await execCommand("where", [commandName], REPO_DIR);
      return firstNonEmptyLine(output);
    } catch {
      return null;
    }
  }

  try {
    const output = await execCommand("/bin/sh", ["-lc", `command -v ${quoteForPosixShell(commandName)}`], REPO_DIR);
    return resolveOutputPath(output);
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


async function syncPiNushellPlugins() {
  const nuPath = await resolveCommandPath("nu");
  if (!nuPath) {
    console.log("skip pi nushell bootstrap: nu not found in vex-managed bin dir or PATH");
    return;
  }

  await mkdir(PI_NUSHELL_DIR, { recursive: true });
  assertSafePath(PI_NUSHELL_PLUGIN_REGISTRY, [HOME]);
  await rm(PI_NUSHELL_PLUGIN_REGISTRY, { force: true });

  const discoveredPlugins = [];
  const skippedPlugins = [];
  for (const plugin of OPTIONAL_NUSHELL_PLUGINS) {
    const binaryPath = await resolveCommandPath(plugin.binary);
    if (!binaryPath) {
      const reason = "binary not found in vex-managed bin dir or PATH";
      console.log(`skip optional nushell plugin (${reason}): ${plugin.binary}`);
      skippedPlugins.push({ name: plugin.name, binary: plugin.binary, reason });
      continue;
    }
    console.log(`registering pi nushell plugin: ${plugin.name} (${binaryPath})`);
    try {
      await execCommand(
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
    } catch (error) {
      const reason = summarizeWarningDetail(error instanceof Error ? error.message : error);
      console.warn(`skip optional nushell plugin (failed to register): ${plugin.name}`);
      console.warn(`  reason: ${reason}`);
      skippedPlugins.push({ name: plugin.name, binary: plugin.binary, reason });
    }
  }
  const configLines = [
    "# Generated by pi-config bootstrap.",
    `# Loads Nushell plugins from ${PI_NUSHELL_PLUGIN_REGISTRY}.`,
  ];
  for (const plugin of discoveredPlugins) {
    configLines.push(`plugin use --plugin-config ${quoteNuString(PI_NUSHELL_PLUGIN_REGISTRY)} ${plugin.name}`);
  }
  if (discoveredPlugins.length === 0) {
    configLines.push("# No optional Nushell plugins were successfully registered during setup.");
  }
  if (skippedPlugins.length > 0) {
    configLines.push("#");
    configLines.push("# !!! WARNING: SOME OPTIONAL NUSHELL PLUGINS WERE SKIPPED DURING BOOTSTRAP !!!");
    for (const plugin of skippedPlugins) {
      configLines.push(`# - ${plugin.name} (${plugin.binary}): ${plugin.reason}`);
    }
  }
  await writeManagedFile(PI_NUSHELL_CONFIG, configLines.join("\n") + "\n");
  console.log(`wrote pi nushell config: ${PI_NUSHELL_CONFIG}`);
  printHugeNushellPluginWarning(skippedPlugins);
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

  await mergeJsonOverlay(SETTINGS_OVERLAY, PI_SETTINGS, PI_SETTINGS_OWNED_STATE, "pi settings overlay");
  await mergeJsonOverlay(VERBOSITY_OVERLAY, PI_VERBOSITY, PI_VERBOSITY_OWNED_STATE, "pi verbosity overlay");
  await syncPiNushellPlugins();

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});