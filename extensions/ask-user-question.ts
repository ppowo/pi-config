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
const REDACTED_FREE_TEXT_ANSWER = "(free-text answer captured)";

const OptionSchema = Type.Object({
  label: Type.String({
    description:
      "Display label shown to the user and returned as the answer text",
  }),
  value: Type.Optional(
    Type.String({
      description:
        "Optional stable machine value for this option. Defaults to the label when omitted.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional clarifying text shown below the label",
    }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Optional stable question identifier used as the key in result answer maps",
    }),
  ),
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
  required: Type.Optional(
    Type.Boolean({
      description: "When false the question can be left unanswered",
    }),
  ),
  minSelections: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Minimum number of selections required for multiSelect questions. Defaults to 1 when required, otherwise 0.",
    }),
  ),
  maxSelections: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Maximum number of selections allowed for multiSelect questions.",
    }),
  ),
});

const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "1 to 4 questions to ask the user",
  }),
  echoFreeTextInContent: Type.Optional(
    Type.Boolean({
      description:
        "When true, free-text answers are echoed in tool content/render output. Defaults to false.",
    }),
  ),
});

type Option = Static<typeof OptionSchema>;
type Question = Static<typeof QuestionSchema>;
type Input = Static<typeof InputSchema>;

const ResultSchema = Type.Object({
  questions: Type.Array(QuestionSchema),
  answers: Type.Record(Type.String(), Type.String()),
  displayAnswers: Type.Record(Type.String(), Type.String()),
  answerValues: Type.Record(Type.String(), Type.String()),
  containsFreeText: Type.Record(Type.String(), Type.Boolean()),
  cancelled: Type.Boolean(),
});

type Result = Static<typeof ResultSchema>;

function questionKey(question: Question): string {
  const id = question.id?.trim();
  return id && id.length > 0 ? id : question.question;
}

function questionIsRequired(question: Question): boolean {
  return question.required !== false;
}

function cancelledResult(questions: Question[]): Result {
  const containsFreeText: Record<string, boolean> = {};

  for (const question of questions) {
    containsFreeText[questionKey(question)] = false;
  }

  return {
    questions,
    answers: {},
    displayAnswers: {},
    answerValues: {},
    containsFreeText,
    cancelled: true,
  };
}

function buildDisplayAnswers(
  result: Pick<Result, "questions" | "answers" | "containsFreeText">,
  echoFreeTextInContent: boolean,
): Record<string, string> {
  const displayAnswers: Record<string, string> = {};

  for (const question of result.questions) {
    const key = questionKey(question);
    const answer = result.answers[key];
    if (answer === undefined) {
      continue;
    }

    displayAnswers[key] =
      !echoFreeTextInContent && result.containsFreeText[key]
        ? REDACTED_FREE_TEXT_ANSWER
        : answer;
  }

  return displayAnswers;
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
  private activeTab = 0;
  private editor: Editor;

  private cachedWidth?: number;
  private cachedLines?: string[];
  private resolved = false;

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

    this.states = questions.map((question) => ({
      cursorIndex: 0,
      selectedIndex: null,
      selectedIndices: new Set<number>(),
      confirmed: !questionIsRequired(question),
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
    return [...q.options, { label: OTHER_OPTION_LABEL, isOther: true as const }];
  }

  private hasAnswer(q: Question, state: QuestionState): boolean {
    if (q.multiSelect) {
      return state.selectedIndices.size > 0 || state.freeTextValue !== null;
    }

    return state.selectedIndex !== null || state.freeTextValue !== null;
  }

  private selectionBounds(q: Question): { min: number; max: number | null } {
    if (!q.multiSelect) {
      return { min: 0, max: null };
    }

    const required = questionIsRequired(q);
    const min = Math.max(0, q.minSelections ?? (required ? 1 : 0));
    const maxInput = q.maxSelections;
    const max = typeof maxInput === "number" ? Math.max(min, maxInput) : null;

    return { min, max };
  }

  private selectionCount(q: Question, state: QuestionState): number {
    if (!q.multiSelect) {
      return this.hasAnswer(q, state) ? 1 : 0;
    }

    let count = state.selectedIndices.size;
    if (state.freeTextValue !== null) {
      count += 1;
    }
    return count;
  }

  private getValidationError(q: Question, state: QuestionState): string | null {
    if (!q.multiSelect) {
      if (questionIsRequired(q) && !this.hasAnswer(q, state)) {
        return "answer required";
      }
      return null;
    }

    const { min, max } = this.selectionBounds(q);
    const count = this.selectionCount(q, state);

    if (count < min) {
      return min === 1
        ? "select at least 1 option"
        : `select at least ${min} options`;
    }

    if (max !== null && count > max) {
      return max === 1
        ? "select no more than 1 option"
        : `select no more than ${max} options`;
    }

    return null;
  }

  private isQuestionSatisfied(index: number): boolean {
    const q = this.questions[index];
    const state = this.states[index];
    const hasAnswer = this.hasAnswer(q, state);

    if (!hasAnswer && !questionIsRequired(q)) {
      return true;
    }

    return state.confirmed && this.getValidationError(q, state) === null;
  }

  private allReadyToSubmit(): boolean {
    return this.questions.every((_, i) => this.isQuestionSatisfied(i));
  }

  private markStateDirty(q: Question, state: QuestionState): void {
    if (!this.hasAnswer(q, state) && !questionIsRequired(q)) {
      state.confirmed = true;
      return;
    }

    state.confirmed = false;
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
      const isActive = i === this.activeTab;
      const header = truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH);
      const label = ` ${header} `;

      let styled: string;
      if (isActive) {
        styled = t.bg("selectedBg", t.fg("text", label));
      } else if (this.isQuestionSatisfied(i)) {
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
    } else if (this.allReadyToSubmit()) {
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

    if (!state.inEditMode) {
      const validationError = this.getValidationError(q, state);
      if (validationError !== null && (state.confirmed || this.hasAnswer(q, state))) {
        add(t.fg("warning", ` ${validationError}`));
        add("");
      }
    }

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
    const allDone = this.allReadyToSubmit();

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
        .map((q, i) => {
          if (this.isQuestionSatisfied(i)) {
            return null;
          }

          const reason = this.getValidationError(q, this.states[i]);
          const header = truncateToWidth(q.header, TAB_HEADER_MAX_WIDTH);
          return reason === null ? header : `${header} (${reason})`;
        })
        .filter((value): value is string => value !== null)
        .join(", ");
      add(t.fg("warning", ` Still needed: ${missing}`));
    }
    add("");
    add(t.fg("dim", " ←→ switch tabs · Esc cancel"));
  }

  private orderedSelectedIndices(state: QuestionState): number[] {
    return [...state.selectedIndices].sort((a, b) => a - b);
  }

  private getAnswerText(q: Question, state: QuestionState): string | null {
    if (!state.confirmed) return null;
    if (!this.hasAnswer(q, state)) return null;

    if (q.multiSelect) {
      const labels: string[] = [];
      for (const idx of this.orderedSelectedIndices(state)) {
        const option = q.options[idx];
        if (option) {
          labels.push(option.label);
        }
      }
      if (state.freeTextValue !== null) {
        labels.push(state.freeTextValue);
      }
      return labels.join(", ");
    }

    if (state.freeTextValue !== null) return state.freeTextValue;
    if (state.selectedIndex !== null) {
      return q.options[state.selectedIndex]?.label ?? null;
    }
    return null;
  }

  private getAnswerValueText(q: Question, state: QuestionState): string | null {
    if (!state.confirmed) return null;
    if (!this.hasAnswer(q, state)) return null;

    if (q.multiSelect) {
      const values: string[] = [];
      for (const idx of this.orderedSelectedIndices(state)) {
        const option = q.options[idx];
        if (option) {
          values.push(option.value ?? option.label);
        }
      }
      if (state.freeTextValue !== null) {
        values.push(state.freeTextValue);
      }
      return values.join(", ");
    }

    if (state.freeTextValue !== null) return state.freeTextValue;
    if (state.selectedIndex !== null) {
      const option = q.options[state.selectedIndex];
      return option ? option.value ?? option.label : null;
    }
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
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];

    if (state.selectedIndices.has(index)) {
      state.selectedIndices.delete(index);
    } else {
      state.selectedIndices.add(index);
    }

    this.markStateDirty(q, state);
    this.rerender();
  }

  private enterEditMode(): void {
    const state = this.states[this.activeTab];
    state.inEditMode = true;
    this.editor.setText(state.freeTextValue ?? "");
    this.rerender();
  }

  private exitEditMode(save: boolean): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];

    if (save) {
      const text = this.editor.getText().trim();
      state.freeTextValue = text.length > 0 ? text : null;
      state.selectedIndex = null;
      this.markStateDirty(q, state);
    }

    this.editor.setText("");
    state.inEditMode = false;
    this.invalidate();
  }

  private autoConfirmIfAnswered(): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    if (!q || !state || state.confirmed) return;

    const valid = this.getValidationError(q, state) === null;
    if (valid && (this.hasAnswer(q, state) || !questionIsRequired(q))) {
      state.confirmed = true;
    }
  }

  private confirmAndAdvance(): void {
    const q = this.questions[this.activeTab];
    const state = this.states[this.activeTab];

    const error = this.getValidationError(q, state);
    if (error !== null) {
      state.confirmed = true;
      this.rerender();
      return;
    }

    state.confirmed = true;
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
    if (!this.allReadyToSubmit()) {
      this.rerender();
      return;
    }

    this.resolved = true;
    this.done(this.buildResult());
  }

  private cancel(): void {
    this.resolved = true;
    this.done(null);
  }

  private buildResult(): Result {
    const answers: Record<string, string> = {};
    const displayAnswers: Record<string, string> = {};
    const answerValues: Record<string, string> = {};
    const containsFreeText: Record<string, boolean> = {};

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const state = this.states[i];
      const key = questionKey(q);

      containsFreeText[key] = state.freeTextValue !== null;

      const answerText = this.getAnswerText(q, state);
      if (answerText === null) {
        continue;
      }

      answers[key] = answerText;
      displayAnswers[key] = answerText;

      const answerValueText = this.getAnswerValueText(q, state);
      answerValues[key] = answerValueText ?? answerText;
    }

    return {
      questions: this.questions,
      answers,
      displayAnswers,
      answerValues,
      containsFreeText,
      cancelled: false,
    };
  }

  handleInput(data: string): void {
    if (this.resolved) return;

    if (!this.isSingle && this.activeTab === this.questions.length) {
      if (matchesKey(data, Key.enter)) {
        if (this.allReadyToSubmit()) this.submit();
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
        this.exitEditMode(true);
        if (!q.multiSelect) {
          if (state.freeTextValue !== null || !questionIsRequired(q)) {
            this.confirmAndAdvance();
          } else {
            this.tui.requestRender();
          }
        } else {
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
      if (
        matchesKey(data, Key.enter) &&
        (state.freeTextValue !== null || !questionIsRequired(q))
      ) {
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
        this.confirmAndAdvance();
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
Optional fields:
- question.id for stable answer keys
- option.value for stable machine values in details.answerValues
- required/minSelections/maxSelections for validation
- echoFreeTextInContent to include free-text answers in content output (default false).
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,
    parameters: InputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as Input;

      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session.",
            },
          ],
          details: cancelledResult(input.questions),
        };
      }

      const result = await ctx.ui.custom<Result | null>(
        (tui, theme, _kb, done) =>
          new AskUserQuestionComponent(input.questions, tui, theme, done),
      );

      if (result === null || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: cancelledResult(input.questions),
        };
      }

      const echoFreeTextInContent = input.echoFreeTextInContent === true;
      const details: Result = {
        ...result,
        displayAnswers: buildDisplayAnswers(result, echoFreeTextInContent),
      };

      const summaryLines = details.questions.map((q) => {
        const key = questionKey(q);
        return `${q.header}: ${details.displayAnswers[key] ?? "(no answer)"}`;
      });

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: details satisfies Result,
      };
    },

    renderCall(args, theme) {
      const questions = ((args as { questions?: Question[] }).questions ?? []) as Question[];
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
        const key = questionKey(q);
        const answer = details.displayAnswers[key] ?? details.answers[key] ?? "(no answer)";
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
