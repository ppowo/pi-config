import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
  Box,
  type Component,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  TruncatedText,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const TOOL_NAME = "ask_user_question";
const TAB_HEADER_MAX_WIDTH = 12;
const OTHER_OPTION_LABEL = "Type your own answer...";

const OptionSchema = Type.Object({
  label: Type.String({
    description:
      "Display label shown to the user and returned as the answer value",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional clarifying text shown below the label",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description: "Full question text displayed to the user",
  }),
  header: Type.String({
    description:
      "Short label used in the tab bar when multiple questions are shown. Max 12 characters.",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "Between 2 and 4 choices for the user to select from",
  }),
  multiSelect: Type.Boolean({
    description:
      "When true the user may select multiple options. Answers are joined with ', '.",
  }),
});

const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "1 to 4 questions to ask the user",
  }),
});

type Option = Static<typeof OptionSchema>;
type Question = Static<typeof QuestionSchema>;

const ResultSchema = Type.Object({
  questions: Type.Array(QuestionSchema),
  answers: Type.Record(Type.String(), Type.String()),
  cancelled: Type.Boolean(),
});

type Result = Static<typeof ResultSchema>;

function cancelledResult(questions: Question[]): Result {
  return { questions, answers: {}, cancelled: true };
}
interface TUILike {
  requestRender(): void;
}

interface QuestionState {
  cursorIndex: number;
  selectedIndex: number | null;
  selectedIndices: Set<number>;
  confirmed: boolean;
  freeTextValue: string | null;
  inEditMode: boolean;
}

type DisplayOption = Option & { isOther?: true };

class AskUserQuestionComponent implements Component {
  private questions: Question[];
  private theme: Theme;
  private tui: TUILike;
  private done: (result: Result | null) => void;

  private states: QuestionState[];
  private activeTab: number = 0;
  private editor: Editor;

  private cachedWidth?: number;
  private cachedLines?: string[];
  private resolved: boolean = false;

  constructor(
    questions: Question[],
    tui: TUILike,
    theme: Theme,
    done: (result: Result | null) => void,
  ) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.done = done;

    this.states = questions.map(() => ({
      cursorIndex: 0,
      selectedIndex: null,
      selectedIndices: new Set<number>(),
      confirmed: false,
      freeTextValue: null,
      inEditMode: false,
    }));

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("muted", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };

    this.editor = new Editor(tui as TUI, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.rerender();
    };

    this.invalidate();
  }

  private allOptions(q: Question): DisplayOption[] {
    return [
      ...q.options,
      { label: OTHER_OPTION_LABEL, isOther: true as const },
    ];
  }

  private allConfirmed(): boolean {
    return this.states.every((s) => s.confirmed);
  }

  private get isSingle(): boolean {
    return this.questions.length === 1;
  }

  private get totalTabs(): number {
    return this.questions.length + 1;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private rerender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    if (this.questions.length === 0) {
      return [];
    }

    const t = this.theme;
    const lines: string[] = [];
    const add = (s: string) => lines.push(truncateToWidth(s, width));

    add(t.fg("accent", "─".repeat(width)));

    if (!this.isSingle) {
      this.renderTabBar(add);
      lines.push("");
    }

    const q = this.questions[this.activeTab];
    if (!q) {
      this.renderSubmitTab(add);
    } else {
      const state = this.states[this.activeTab];
      this.renderQuestionBody(q, state, width, add);
    }

    add(t.fg("accent", "─".repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderTabBar(add: (s: string) => void): void {
    const t = this.theme;
    const parts: string[] = [" "];

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const s = this.states[i];
      const isActive = i === this.activeTab;
      const header = truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH);
      const label = ` ${header} `;

      let styled: string;
      if (isActive) {
        styled = t.bg("selectedBg", t.fg("text", label));
      } else if (s.confirmed) {
        styled = t.fg("success", ` ■${header} `);
      } else {
        styled = t.fg("muted", `  ${header} `);
      }
      parts.push(styled);
    }

    const isSubmitActive = this.activeTab === this.questions.length;
    const submitLabel = " ✓ Submit ";
    let submitStyled: string;
    if (isSubmitActive) {
      submitStyled = t.bg("selectedBg", t.fg("text", submitLabel));
    } else if (this.allConfirmed()) {
      submitStyled = t.fg("success", submitLabel);
    } else {
      submitStyled = t.fg("dim", submitLabel);
    }
    parts.push(submitStyled);

    add(parts.join(""));
  }

  private renderQuestionBody(
    q: Question,
    state: QuestionState,
    width: number,
    add: (s: string) => void,
  ): void {
    const t = this.theme;
    const opts = this.allOptions(q);

    for (const line of wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - 2)) {
      add(line);
    }
    add("");

    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      const isSelected = i === state.cursorIndex;
      const isOther = opt.isOther === true;
      const prefix = isSelected ? t.fg("accent", ">") : " ";

      if (q.multiSelect && !isOther) {
        const checked = state.selectedIndices.has(i);
        const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
        const labelColor = isSelected ? "accent" : "text";
        add(`${prefix} ${box} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
      } else if (isOther) {
        const hasFreeText = state.freeTextValue !== null && !state.inEditMode;
        const suffix = state.inEditMode ? t.fg("accent", " ✎") : "";
        const labelColor = isSelected ? "accent" : "muted";
        if (q.multiSelect) {
          const box = hasFreeText ? t.fg("success", "[✓]") : t.fg("dim", "[ ]");
          add(
            `${prefix} ${box} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}${suffix}`,
          );
        } else {
          const check = hasFreeText ? t.fg("success", "✓") : " ";
          add(
            `${prefix} ${check} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}${suffix}`,
          );
        }
        if (hasFreeText) {
          const indent = q.multiSelect ? "       " : "     ";
          const preview = truncateToWidth(
            state.freeTextValue ?? "",
            width - indent.length,
          );
          add(`${indent}${t.fg("dim", `"${preview}"`)}`);
        }
      } else {
        const isConfirmedChoice = state.selectedIndex === i;
        const check = isConfirmedChoice ? t.fg("success", "✓") : " ";
        const labelColor = isSelected ? "accent" : "text";
        add(`${prefix} ${check} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
      }

      if (!isOther && opt.description) {
        const indent = q.multiSelect ? "       " : "     ";
        for (const line of wrapTextWithAnsi(
          t.fg("muted", opt.description),
          width - indent.length,
        )) {
          add(`${indent}${line}`);
        }
      }
    }

    if (state.inEditMode) {
      add("");
      add(t.fg("muted", " Your answer:"));
      for (const line of this.editor.render(width - 4)) {
        add(` ${line}`);
      }
    }

    add("");

    if (state.inEditMode) {
      add(t.fg("dim", " Enter submit · Esc back"));
    } else {
      const onOther = state.cursorIndex === opts.length - 1;
      const tabHint = this.isSingle ? "" : " · ←→ switch tabs";
      let actionHint: string;
      if (onOther) {
        actionHint = "Space/Tab open editor";
      } else if (q.multiSelect) {
        actionHint = "Space toggle · Enter confirm";
      } else {
        actionHint = "Enter select";
      }
      add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc cancel`));
    }
  }

  private renderSubmitTab(add: (s: string) => void): void {
    const t = this.theme;
    const allDone = this.allConfirmed();

    add(
      allDone
        ? t.fg("success", t.bold(" Ready to submit"))
        : t.fg("warning", t.bold(" Unanswered questions")),
    );
    add("");

    for (const [i, q] of this.questions.entries()) {
      const answer = this.getAnswerText(q, this.states[i]);
      if (answer !== null) {
        add(
          t.fg("muted", ` ${truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH)}: `) +
            t.fg("text", answer),
        );
      } else {
        add(
          t.fg("dim", ` ${truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH)}: `) +
            t.fg("warning", "—"),
        );
      }
    }

    add("");
    if (allDone) {
      add(t.fg("success", " Press Enter to submit"));
    } else {
      const missing = this.questions
        .filter((_, i) => !this.states[i].confirmed)
        .map((q) => truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH))
        .join(", ");
      add(t.fg("warning", ` Still needed: ${missing}`));
    }
    add("");
    add(t.fg("dim", " ←→ switch tabs · Esc cancel"));
  }

  private getAnswerText(q: Question, state: QuestionState): string | null {
    if (!state.confirmed) return null;

    if (q.multiSelect) {
      const labels = [...state.selectedIndices]
        .sort((a, b) => a - b)
        .map((idx) => q.options[idx].label);
      if (state.freeTextValue !== null) labels.push(state.freeTextValue);
      return labels.join(", ");
    }

    if (state.freeTextValue !== null) return state.freeTextValue;
    if (state.selectedIndex !== null) return q.options[state.selectedIndex].label;
    return null;
  }

  private moveCursor(delta: -1 | 1): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    const max = this.allOptions(q).length - 1;
    state.cursorIndex = Math.max(0, Math.min(max, state.cursorIndex + delta));
    this.rerender();
  }

  private toggleSelected(index: number): void {
    const state = this.states[this.activeTab];
    if (state.selectedIndices.has(index)) {
      state.selectedIndices.delete(index);
    } else {
      state.selectedIndices.add(index);
    }

    if (state.selectedIndices.size === 0 && state.freeTextValue === null) {
      state.confirmed = false;
    }

    this.rerender();
  }

  private enterEditMode(): void {
    const state = this.states[this.activeTab];
    state.inEditMode = true;
    this.editor.setText(state.freeTextValue ?? "");
    this.rerender();
  }

  private exitEditMode(save: boolean): void {
    const state = this.states[this.activeTab];
    if (save) {
      state.freeTextValue = this.editor.getText().trim();
      state.selectedIndex = null;
    } else if (!state.confirmed) {
      state.freeTextValue = null;
    }

    this.editor.setText("");
    state.inEditMode = false;
    this.invalidate();
  }

  private autoConfirmIfAnswered(): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    if (!q || !state || state.confirmed) return;

    if (q.multiSelect) {
      if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
        state.confirmed = true;
      }
    } else if (state.freeTextValue !== null || state.selectedIndex !== null) {
      state.confirmed = true;
    }
  }

  private confirmAndAdvance(): void {
    this.states[this.activeTab].confirmed = true;
    this.advance();
  }

  private advance(): void {
    if (this.isSingle) {
      this.submit();
      return;
    }

    if (this.activeTab < this.questions.length - 1) {
      this.activeTab++;
    } else {
      this.activeTab = this.questions.length;
    }

    this.rerender();
  }

  private submit(): void {
    this.resolved = true;
    this.done(this.buildResult());
  }

  private cancel(): void {
    this.resolved = true;
    this.done(null);
  }

  private buildResult(): Result {
    const answers: Record<string, string> = {};
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const s = this.states[i];
      const answer = this.getAnswerText(q, s);
      if (answer === null) continue;
      answers[q.question] = answer;
    }

    return { questions: this.questions, answers, cancelled: false };
  }

  handleInput(data: string): void {
    if (this.resolved) return;

    if (!this.isSingle && this.activeTab === this.questions.length) {
      if (matchesKey(data, Key.enter)) {
        if (this.allConfirmed()) this.submit();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.cancel();
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.activeTab = 0;
        this.rerender();
        return;
      }
      if (matchesKey(data, Key.left)) {
        this.activeTab = this.questions.length - 1;
        this.rerender();
        return;
      }
      return;
    }

    const state = this.states[this.activeTab];
    const q = this.questions[this.activeTab];

    if (state.inEditMode) {
      if (matchesKey(data, Key.escape)) {
        this.exitEditMode(false);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const text = this.editor.getText().trim();
        if (text) {
          this.exitEditMode(true);
          if (!q.multiSelect) {
            this.confirmAndAdvance();
          } else {
            this.tui.requestRender();
          }
        } else {
          state.freeTextValue = null;
          if (q.multiSelect && state.selectedIndices.size === 0) {
            state.confirmed = false;
          }
          this.exitEditMode(false);
          this.tui.requestRender();
        }
        return;
      }
      this.editor.handleInput(data);
      this.rerender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }

    if (!this.isSingle && matchesKey(data, Key.right)) {
      this.autoConfirmIfAnswered();
      this.activeTab = (this.activeTab + 1) % this.totalTabs;
      this.rerender();
      return;
    }

    if (!this.isSingle && matchesKey(data, Key.left)) {
      this.autoConfirmIfAnswered();
      this.activeTab = (this.activeTab - 1 + this.totalTabs) % this.totalTabs;
      this.rerender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      return;
    }

    const opts = this.allOptions(q);
    const onOther = state.cursorIndex === opts.length - 1;

    if (onOther) {
      if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
        this.enterEditMode();
        return;
      }
      if (matchesKey(data, Key.enter) && state.freeTextValue !== null) {
        this.confirmAndAdvance();
        return;
      }
    }

    if (q.multiSelect) {
      if (matchesKey(data, Key.space) && !onOther) {
        this.toggleSelected(state.cursorIndex);
        return;
      }
      if (matchesKey(data, Key.enter) && !onOther) {
        if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
          this.confirmAndAdvance();
        }
        return;
      }
    } else if (matchesKey(data, Key.enter) && !onOther) {
      state.selectedIndex = state.cursorIndex;
      state.freeTextValue = null;
      this.confirmAndAdvance();
      return;
    }
  }
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User",
    description: `Ask the user 1–4 clarifying questions before proceeding.
Use this tool when multiple valid approaches exist and you need the user's preference to continue.
Each question must have 2–4 options for the user to choose from.
Set multiSelect: true when more than one option can validly apply at the same time.
The header field is a short label (max 12 characters) used in the tab bar when showing multiple questions.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,
    parameters: InputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => name !== TOOL_NAME),
        );
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
            },
          ],
          details: cancelledResult(params.questions),
        };
      }

      const result = await ctx.ui.custom<Result | null>(
        (tui, theme, _kb, done) =>
          new AskUserQuestionComponent(params.questions, tui, theme, done),
      );

      if (result === null || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: cancelledResult(params.questions),
        };
      }

      const summaryLines = result.questions.map(
        (q) => `${q.header}: ${result.answers[q.question] ?? "(no answer)"}`,
      );

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: result satisfies Result,
      };
    },

    renderCall(args, theme) {
      const questions = (args.questions ?? []) as Question[];
      const topics = questions.map((q) => q.header).join(", ");
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("ask user ")) +
          theme.fg("muted", topics),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;

      if (!details) {
        const t = result.content[0];
        return new TruncatedText(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (details.cancelled) {
        return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const box = new Box(0, 0);
      for (const q of details.questions) {
        const answer = details.answers[q.question] ?? "(no answer)";
        box.addChild(
          new TruncatedText(
            theme.fg("success", "✓ ") +
              theme.fg("accent", `${q.header}: `) +
              theme.fg("text", answer),
            0,
            0,
          ),
        );
      }
      return box;
    },
  });
}
