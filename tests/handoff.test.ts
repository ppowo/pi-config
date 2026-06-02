import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileData, formatSummary, loadSessionMessages, stripSyntheticHandoffMessages } from "../extensions/handoff/core";
import { buildHandoffPrompt, formatSessionLineage } from "../extensions/handoff/prompt";
import { collectSessionLineage } from "../extensions/handoff/session-lineage";

const user = (content: string) => ({ role: "user", content }) as any;
const assistantText = (content: string) => ({ role: "assistant", content }) as any;
const toolCall = (name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", name, arguments: args }],
}) as any;
const toolResult = (toolName: string, content: string, isError = false) => ({
  role: "toolResult",
  toolName,
  content,
  isError,
}) as any;

describe("handoff core extraction", () => {
  // Purpose: proves the handoff summary is compiled from observable conversation events,
  // not from guessed assistant prose. Git commits are only trusted after a git-log call.
  it("extracts goals, changed files, trusted git commits, and preferences", () => {
    const data = compileData([
      user("Implement handoff tests. Please keep answers concise."),
      toolCall("read", { path: "/repo/extensions/handoff.ts" }),
      toolCall("edit", { path: "/repo/extensions/handoff.ts" }),
      toolCall("bash", { command: "git log --oneline -3" }),
      toolResult("bash", "abc1234 feat: add blackhole\ndef5678 fix: keep cache"),
      assistantText("abc9999 this assistant text must not become a commit"),
      toolResult("bash", "9999999 not from git log"),
    ]);

    assert.deepEqual(data.sessionGoal, ["Implement handoff tests. Please keep answers concise."]);
    assert.deepEqual(data.filesAndChanges, ["Modified: handoff.ts"]);
    assert.deepEqual(data.commits, ["abc1234: feat: add blackhole", "def5678: fix: keep cache"]);
    assert.deepEqual(data.userPreferences, ["Implement handoff tests. Please keep answers concise."]);
  });

  // Purpose: keeps pi-injected reminders out of the handoff while preserving real unresolved work.
  it("filters system reminder noise and avoids duplicating goal-like blockers", () => {
    const data = compileData([
      user("Fix the build failure"),
      user("<system-reminder>no response requested</system-reminder>"),
      assistantText("The current blocker is the build still fails"),
    ]);

    assert.deepEqual(data.sessionGoal, ["Fix the build failure"]);
    assert.deepEqual(data.outstandingContext, ["The current blocker is the build still fails"]);
  });

  // Purpose: prevents recursive handoffs from treating the previous generated continuation prompt as user intent.
  it("strips synthetic handoff continuation messages", () => {
    const messages = [
      user("real request"),
      user("/skill:session-query Continue this task from the session lineage below.\n\n**Goal:** Continue\n\n**Parent session:** `/tmp/session.jsonl`"),
    ];

    assert.equal(stripSyntheticHandoffMessages(messages as any).length, 1);
  });

  // Purpose: locks the user-facing handoff shape enough that session_query guidance and key sections survive refactors.
  it("formats a stable summary with session_query guidance", () => {
    const summary = formatSummary({
      sessionGoal: ["Implement handoff tests"],
      filesAndChanges: ["Modified: extensions/handoff.ts"],
      commits: ["abc1234: feat: add blackhole"],
      briefTranscript: ["[user] Implement handoff tests"],
      outstandingContext: [],
      userPreferences: ["Please keep answers concise"],
    });

    assert.match(summary, /\[Session Goal\]/);
    assert.match(summary, /\[Commits\]/);
    assert.match(summary, /Please keep answers concise/);
  });


  // Purpose: keeps generated-prompt invariants behind one interface so index.ts
  // does not need to know prompt section ordering or lineage formatting details.
  it("builds handoff prompts from lineage refs", () => {
    const prompt = buildHandoffPrompt("Continue", "/tmp/parent.jsonl", "[Session Goal]\n- Continue", [{ relation: "Parent", sessionFile: "/tmp/parent.jsonl", data: {
      sessionGoal: ["Continue"],
      filesAndChanges: [],
      commits: [],
      briefTranscript: [],
      outstandingContext: [],
      userPreferences: [],
    } }]);

    assert.match(prompt, /session lineage below/);
    assert.match(prompt, /\*\*Parent session summary:\*\*/);
    assert.match(prompt, /1\. Parent:/);
    assert.match(prompt, /Do not query every session/);
  });

  // Purpose: verifies the real session JSONL loader skips headers and malformed
  // lines while returning message records that can be compiled into a handoff.
  it("loads message records from a pi session jsonl file", () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-test-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", parentSession: "/tmp/parent.jsonl" }),
      "not json",
      JSON.stringify({ role: "user", content: "Continue the handoff split" }),
      JSON.stringify({ role: "assistant", content: "Done" }),
    ].join("\n"));

    const messages = loadSessionMessages(sessionFile);

    assert.equal(messages.length, 2);
    assert.deepEqual(compileData(messages).sessionGoal, ["Continue the handoff split"]);
  });


  // Purpose: preserves the current ancestor-chain contract: the new handoff shows
  // a full parent summary, compact older ancestor cards, and guidance to query only matching refs.
  it("formats bounded lineage refs from parent sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-lineage-test-"));
    const grandparent = join(dir, "grandparent.jsonl");
    const parent = join(dir, "parent.jsonl");
    writeFileSync(grandparent, [
      JSON.stringify({ type: "session" }),
      JSON.stringify({ role: "user", content: "Inspect the blackhole commits" }),
      JSON.stringify({ role: "assistant", content: "Done" }),
    ].join("\n"));
    writeFileSync(parent, [
      JSON.stringify({ type: "session", parentSession: grandparent }),
      JSON.stringify({ role: "user", content: "Split up the handoff extension" }),
      JSON.stringify({ role: "assistant", content: "Modified extensions/handoff/core.ts" }),
    ].join("\n"));

    const parentData = compileData(loadSessionMessages(parent));
    const lineage = formatSessionLineage(collectSessionLineage(parent, parentData));

    assert.match(lineage, /1\. Parent:/);
    assert.match(lineage, /Summary: see Parent session summary above/);
    assert.match(lineage, /2\. Grandparent:/);
    assert.match(lineage, /Goal: Inspect the blackhole commits/);
    assert.match(lineage, /Use visible summaries first\. Do not query every session/);
  });
});
