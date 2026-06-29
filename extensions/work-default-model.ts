import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORK_PROVIDER = "openrouter";
const WORK_MODEL_ID = "deepseek/deepseek-v4-flash";
const WORK_THINKING_LEVEL = "xhigh";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "work-default-model.json");
const ENFORCED_REASONS = new Set(["startup", "new"]);
const ENFORCE_DELAYS_MS = [0, 250, 1000] as const;

type WorkDefaultModelConfig = {
  enabled?: unknown;
};

function readConfig(): WorkDefaultModelConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WorkDefaultModelConfig;
  } catch {
    return {};
  }
}

export function workDefaultEnabled(config: WorkDefaultModelConfig = readConfig()): boolean {
  return config.enabled === true;
}

async function enforceWorkDefault(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!workDefaultEnabled()) return;

  const model = ctx.modelRegistry.find(WORK_PROVIDER, WORK_MODEL_ID);
  if (!model) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Work default model not found: ${WORK_PROVIDER}/${WORK_MODEL_ID}`, "error");
    }
    return;
  }

  const ok = await pi.setModel(model);
  if (!ok) {
    if (ctx.hasUI) {
      ctx.ui.notify(`No auth configured for work default model: ${WORK_PROVIDER}/${WORK_MODEL_ID}`, "error");
    }
    return;
  }

  pi.setThinkingLevel(WORK_THINKING_LEVEL);
}

function scheduleWorkDefaultEnforcement(pi: ExtensionAPI, ctx: ExtensionContext): void {
  for (const delayMs of ENFORCE_DELAYS_MS) {
    setTimeout(() => {
      void enforceWorkDefault(pi, ctx);
    }, delayMs);
  }
}

export default function workDefaultModel(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (!ENFORCED_REASONS.has(event.reason)) return;
    scheduleWorkDefaultEnforcement(pi, ctx);
  });
}
