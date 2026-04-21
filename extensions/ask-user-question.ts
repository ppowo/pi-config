import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
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
const CLARIFICATION_OPTION_LABEL = "Ask a clarification question first...";
const REDACTED_FREE_TEXT_ANSWER = "(free-text answer captured)";
const REDACTED_CLARIFICATION_REQUEST = "(clarification request captured)";
const FREE_TEXT_HINT = "Write a custom answer not covered by the listed options.";
const CLARIFICATION_HINT = "Ask a follow-up question before answering.";
const CLARIFICATION_PATTERNS = [
  /[?？]/,
  /^\s*(what|which|why|how|when|where|who|whom|whose|can|could|would|should|do|does|did|is|are|am|was|were|will|may|might)\b/i,
  /\b(clarify|what do you mean|which one|which option|difference|not sure|do not understand|don't understand|before i answer|need more context|need more information)\b/i,
] as const;

const OptionSchema = Type.Object({
  label: Type.String({
    description: "Display label shown to the user and returned as the answer text",
  }),
  value: Type.Optional(
    Type.String({
      description:
        "Optional stable machine value for this option. Defaults to the label when omitted.",
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Optional clarifying text shown below the label" }),
  ),
});

const OptionInputSchema = Type.Union(
  [
    Type.String({
      description: "Shorthand option label. Equivalent to { label: <string> }.",
    }),
    OptionSchema,
  ],
  {
    description:
      "Each option may be a string label or an object with label/value/description.",
  },
);
const QuestionSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Optional stable question identifier used as the key in result answer maps",
    }),
  ),
  question: Type.String({ description: "Full question text displayed to the user" }),
  header: Type.Optional(
    Type.String({
      description:
        "Optional short label used in the tab bar when showing multiple questions. Max 12 characters. Defaults to question.id or a shortened question text.",
    }),
  ),
  options: Type.Array(OptionInputSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "Between 2 and 4 choices for the user to select from. Each option may be a string label or { label, value?, description? }.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "When true the user may select multiple options. Answers are joined with ', '. Defaults to false.",
    }),
  ),
  required: Type.Optional(
    Type.Boolean({ description: "When false the question can be left unanswered" }),
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
      description: "Maximum number of selections allowed for multiSelect questions.",
    }),
  ),
  allowFreeText: Type.Optional(
    Type.Boolean({
      description:
        "When false, hide the built-in free-text and clarification-request editor options. Defaults to true.",
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
type OptionInput = Static<typeof OptionInputSchema>;
type QuestionInput = Static<typeof QuestionSchema>;
type Question = Omit<QuestionInput, "options" | "multiSelect"> & {
  options: Option[];
  multiSelect: boolean;
};
type Input = Static<typeof InputSchema>;
type NormalizedInput = {
  questions: Question[];
  echoFreeTextInContent?: boolean;
};
type QuestionHeaderSource = Pick<QuestionInput, "header" | "id" | "question">;
type FreeTextIntent = "answer" | "clarification_request";
type DisplayOption = Option & { specialKind?: FreeTextIntent };

interface FreeTextEntry {
  value: string;
  intent: FreeTextIntent;
}

interface Result {
  questions: Question[];
  answers: Record<string, string>;
  displayAnswers: Record<string, string>;
  answerValues: Record<string, string>;
  containsFreeText: Record<string, boolean>;
  freeTextIntents: Record<string, FreeTextIntent>;
  cancelled: boolean;
}

interface QuestionState {
  cursorIndex: number;
  selectedIndex: number | null;
  selectedIndices: Set<number>;
  confirmed: boolean;
  freeText: FreeTextEntry | null;
  editingIntent: FreeTextIntent | null;
}

interface TUILike {
  requestRender(): void;
}

function normalizeOption(option: OptionInput): Option {
  return typeof option === "string" ? { label: option } : option;
}

function normalizeQuestion(question: QuestionInput): Question {
  const header = question.header?.trim();
  return {
    ...question,
    header: header && header.length > 0 ? header : undefined,
    options: question.options.map(normalizeOption),
    multiSelect: question.multiSelect === true,
  };
}

function normalizeInput(input: Input): NormalizedInput {
  return {
    ...input,
    questions: input.questions.map(normalizeQuestion),
  };
}

function questionHeader(question: QuestionHeaderSource): string {
  const header = question.header?.trim();
  if (header) return header;
  const id = question.id?.trim();
  if (id) return id;
  const fallback = truncateToWidth(question.question.trim(), TAB_HEADER_MAX_WIDTH).trim();
  return fallback.length > 0 ? fallback : "Question";
}

function questionTabHeader(question: QuestionHeaderSource): string {
  return truncateToWidth(questionHeader(question), TAB_HEADER_MAX_WIDTH);
}

function questionKey(question: Question): string {
  const id = question.id?.trim();
  return id && id.length > 0 ? id : question.question;
}

function questionKeys(questions: Question[]): string[] {
  const raw = questions.map(questionKey);
  const counts = new Map<string, number>();
  const used = new Map<string, number>();

  for (const key of raw) counts.set(key, (counts.get(key) ?? 0) + 1);

  return raw.map((key) => {
    if ((counts.get(key) ?? 0) <= 1) return key;
    const index = (used.get(key) ?? 0) + 1;
    used.set(key, index);
    return `${key}#${index}`;
  });
}

function questionIsRequired(question: Question): boolean {
  return question.required !== false;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function looksLikeListedOption(answer: string, question: Question): boolean {
  const normalizedAnswer = normalizeForMatch(answer);
  if (!normalizedAnswer) return false;

  return question.options.some((option) =>
    [option.label, option.value]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalizeForMatch(value) === normalizedAnswer),
  );
}

function resolveFreeTextIntent(
  value: string,
  question: Question,
  preferredIntent: FreeTextIntent,
): FreeTextIntent {
  if (preferredIntent === "clarification_request") return preferredIntent;
  if (looksLikeListedOption(value, question)) return "answer";
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(value))
    ? "clarification_request"
    : "answer";
}

function hasAnswer(question: Question, state: QuestionState): boolean {
  return question.multiSelect
    ? state.selectedIndices.size > 0 || state.freeText !== null
    : state.selectedIndex !== null || state.freeText !== null;
}

function selectionBounds(question: Question): { min: number; max: number | null } {
  if (!question.multiSelect) return { min: 0, max: null };
  const min = questionIsRequired(question)
    ? Math.max(1, question.minSelections ?? 1)
    : Math.max(0, question.minSelections ?? 0);
  const max =
    typeof question.maxSelections === "number"
      ? Math.max(min, question.maxSelections)
      : null;
  return { min, max };
}

function selectionCount(question: Question, state: QuestionState): number {
  if (!question.multiSelect) return hasAnswer(question, state) ? 1 : 0;
  return state.selectedIndices.size + (state.freeText ? 1 : 0);
}

function validationError(question: Question, state: QuestionState): string | null {
  if (!question.multiSelect) {
    return questionIsRequired(question) && !hasAnswer(question, state)
      ? "answer required"
      : null;
  }

  const { min, max } = selectionBounds(question);
  const count = selectionCount(question, state);
  if (count < min) return min === 1 ? "select at least 1 option" : `select at least ${min} options`;
  if (max !== null && count > max) {
    return max === 1 ? "select no more than 1 option" : `select no more than ${max} options`;
  }
  return null;
}

function markStateDirty(question: Question, state: QuestionState): void {
  state.confirmed = !hasAnswer(question, state) && !questionIsRequired(question);
}

function orderedSelectedIndices(state: QuestionState): number[] {
  return [...state.selectedIndices].sort((a, b) => a - b);
}

function answerText(question: Question, state: QuestionState): string | null {
  if (!state.confirmed || !hasAnswer(question, state)) return null;
  if (!question.multiSelect) {
    if (state.freeText) return state.freeText.value;
    return state.selectedIndex === null ? null : question.options[state.selectedIndex]?.label ?? null;
  }

  const values = orderedSelectedIndices(state)
    .map((index) => question.options[index]?.label)
    .filter((value): value is string => Boolean(value));
  if (state.freeText) values.push(state.freeText.value);
  return values.length > 0 ? values.join(", ") : null;
}

function answerValueText(question: Question, state: QuestionState): string | null {
  if (!state.confirmed || !hasAnswer(question, state)) return null;
  if (!question.multiSelect) {
    if (state.freeText) return state.freeText.value;
    if (state.selectedIndex === null) return null;
    const option = question.options[state.selectedIndex];
    return option ? option.value ?? option.label : null;
  }

  const values = orderedSelectedIndices(state)
    .map((index) => question.options[index])
    .filter((option): option is Option => Boolean(option))
    .map((option) => option.value ?? option.label);
  if (state.freeText) values.push(state.freeText.value);
  return values.length > 0 ? values.join(", ") : null;
}

function isSatisfied(question: Question, state: QuestionState): boolean {
  if (!hasAnswer(question, state) && !questionIsRequired(question)) return true;
  return state.confirmed && validationError(question, state) === null;
}

type QuestionDisplayState = "pending" | "answered" | "clarification" | "skipped";

function questionDisplayState(question: Question, state: QuestionState): QuestionDisplayState {
  if (!hasAnswer(question, state)) return questionIsRequired(question) ? "pending" : "skipped";
  if (state.freeText?.intent === "clarification_request") return "clarification";
  return answerText(question, state) === null ? "pending" : "answered";
}

function questionTabDisplay(question: Question, state: QuestionState): {
  label: string;
  color: "dim" | "muted" | "warning" | "success";
} {
  const header = questionTabHeader(question);
  const displayState = questionDisplayState(question, state);
  if (displayState === "clarification") return { label: ` ask ${header} `, color: "warning" };
  if (displayState === "answered") return { label: ` ok ${header} `, color: "success" };
  if (displayState === "skipped") return { label: ` ${header} `, color: "dim" };
  return { label: ` ${header} `, color: hasAnswer(question, state) ? "warning" : "muted" };
}

function questionSummaryBadge(question: Question, state: QuestionState): {
  label: string;
  color: "dim" | "warning" | "success";
} {
  const displayState = questionDisplayState(question, state);
  if (displayState === "clarification") return { label: "[ask]", color: "warning" };
  if (displayState === "answered") return { label: "[done]", color: "success" };
  if (displayState === "skipped") return { label: "[skip]", color: "dim" };
  return { label: "[pending]", color: "warning" };
}

function cancelledResult(questions: Question[]): Result {
  const containsFreeText: Record<string, boolean> = {};
  for (const key of questionKeys(questions)) containsFreeText[key] = false;
  return {
    questions,
    answers: {},
    displayAnswers: {},
    answerValues: {},
    containsFreeText,
    freeTextIntents: {},
    cancelled: true,
  };
}

function buildDisplayAnswers(
  result: Pick<Result, "questions" | "answers" | "containsFreeText" | "freeTextIntents">,
  echoFreeTextInContent: boolean,
): Record<string, string> {
  const displayAnswers: Record<string, string> = {};
  const keys = questionKeys(result.questions);

  for (let i = 0; i < result.questions.length; i++) {
    const key = keys[i];
    const answer = result.answers[key];
    if (answer === undefined) continue;
    if (!echoFreeTextInContent && result.containsFreeText[key]) {
      displayAnswers[key] =
        result.freeTextIntents[key] === "clarification_request"
          ? REDACTED_CLARIFICATION_REQUEST
          : REDACTED_FREE_TEXT_ANSWER;
      continue;
    }
    displayAnswers[key] = answer;
  }

  return displayAnswers;
}

function buildToolContent(
  result: Pick<Result, "questions" | "answers" | "displayAnswers" | "freeTextIntents">,
): string {
  const keys = questionKeys(result.questions);
  const summaryLines: string[] = [];
  const clarificationLines: string[] = [];

  for (let i = 0; i < result.questions.length; i++) {
    const question = result.questions[i];
    const key = keys[i];
    const header = questionHeader(question);
    const answer = result.answers[key];
    if (answer === undefined) {
      summaryLines.push(`${header}: (no answer)`);
      continue;
    }
    if (result.freeTextIntents[key] === "clarification_request") {
      summaryLines.push(`${header}: (clarification requested)`);
      clarificationLines.push(`- ${header}: ${answer}`);
      continue;
    }

    summaryLines.push(`${header}: ${result.displayAnswers[key] ?? answer}`);
  }

  if (clarificationLines.length === 0) return summaryLines.join("\n");

  const plural = clarificationLines.length === 1 ? "" : "s";
  const reference = clarificationLines.length === 1 ? "this clarification" : "these clarifications";
  const questionLabel = clarificationLines.length === 1 ? "question" : "questions";

  return [
    ...summaryLines,
    "",
    `User clarification request${plural}:`,
    ...clarificationLines,
    "",
    `The user asked for clarification instead of answering the affected ${questionLabel}.`,
    `Respond to the clarification request${plural} directly in normal assistant text. Do not call ask_user_question again for ${reference}. Treat the affected ${questionLabel} as unresolved until the user answers after you clarify.`,
  ].join("\n");
}

class AskUserQuestionComponent implements Component {
  private questions: Question[];
  private theme: Theme;
  private tui: TUILike;
  private done: (result: Result | null) => void;
  private states: QuestionState[];
  private activeTab = 0;
  private editor: Editor;
  private resolvedKeys: string[];
  private resolved = false;

  constructor(
    questions: Question[],
    tui: TUILike,
    theme: Theme,
    done: (result: Result | null) => void,
  ) {
    this.questions = questions;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.states = questions.map((question) => ({
      cursorIndex: 0,
      selectedIndex: null,
      selectedIndices: new Set<number>(),
      confirmed: !questionIsRequired(question),
      freeText: null,
      editingIntent: null,
    }));
    this.resolvedKeys = questionKeys(questions);

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("muted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };

    this.editor = new Editor(tui as TUI, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => this.tui.requestRender();
  }

  invalidate(): void {}

  private get isSingle(): boolean {
    return this.questions.length === 1;
  }

  private get totalTabs(): number {
    return this.questions.length + 1;
  }

  private allOptions(question: Question): DisplayOption[] {
    if (question.allowFreeText === false) return question.options as DisplayOption[];
    return [
      ...question.options,
      { label: OTHER_OPTION_LABEL, description: FREE_TEXT_HINT, specialKind: "answer" },
      {
        label: CLARIFICATION_OPTION_LABEL,
        description: CLARIFICATION_HINT,
        specialKind: "clarification_request",
      },
    ];
  }

  private currentQuestion(): Question {
    return this.questions[this.activeTab];
  }

  private currentState(): QuestionState {
    return this.states[this.activeTab];
  }

  private allReadyToSubmit(): boolean {
    return this.questions.every((question, index) => isSatisfied(question, this.states[index]));
  }

  private firstUnsatisfiedTab(): number | null {
    for (let i = 0; i < this.questions.length; i++) {
      if (!isSatisfied(this.questions[i], this.states[i])) return i;
    }
    return null;
  }

  private hasAnyAnswers(): boolean {
    return this.questions.some((question, index) => hasAnswer(question, this.states[index]));
  }

  private clearClarification(state: QuestionState): void {
    if (state.freeText?.intent === "clarification_request") state.freeText = null;
  }

  private enterEditMode(intent: FreeTextIntent): void {
    const state = this.currentState();
    state.editingIntent = intent;
    this.editor.setText(state.freeText?.intent === intent ? state.freeText.value : "");
    this.tui.requestRender();
  }

  private exitEditMode(save: boolean): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    const intent = state.editingIntent;

    if (save && intent) {
      const value = this.editor.getText().trim();
      if (value.length > 0) {
        state.freeText = { value, intent: resolveFreeTextIntent(value, question, intent) };
        if (state.freeText.intent === "clarification_request") {
          state.selectedIndex = null;
          state.selectedIndices.clear();
        } else if (!question.multiSelect) {
          state.selectedIndex = null;
        }
      } else if (state.freeText?.intent === intent) {
        state.freeText = null;
      }
      markStateDirty(question, state);
    }

    this.editor.setText("");
    state.editingIntent = null;
    this.tui.requestRender();
  }

  private toggleSelected(index: number): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    this.clearClarification(state);
    if (state.selectedIndices.has(index)) state.selectedIndices.delete(index);
    else state.selectedIndices.add(index);
    markStateDirty(question, state);
    this.tui.requestRender();
  }

  private autoConfirmIfAnswered(): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    if (state.confirmed) return;
    if (validationError(question, state) === null && (hasAnswer(question, state) || !questionIsRequired(question))) {
      state.confirmed = true;
    }
  }

  private confirmAndAdvance(): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    if (validationError(question, state) !== null) {
      state.confirmed = true;
      this.tui.requestRender();
      return;
    }

    state.confirmed = true;
    if (this.isSingle) {
      this.submit();
      return;
    }

    this.activeTab = this.firstUnsatisfiedTab() ?? this.questions.length;
    this.tui.requestRender();
  }

  private submit(): void {
    if (!this.allReadyToSubmit()) {
      this.tui.requestRender();
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
    const freeTextIntents: Record<string, FreeTextIntent> = {};

    for (let i = 0; i < this.questions.length; i++) {
      const question = this.questions[i];
      const state = this.states[i];
      const key = this.resolvedKeys[i];
      containsFreeText[key] = state.freeText !== null;
      if (state.freeText) {
        freeTextIntents[key] = resolveFreeTextIntent(
          state.freeText.value,
          question,
          state.freeText.intent,
        );
      }

      const text = answerText(question, state);
      if (text === null) continue;
      answers[key] = text;
      displayAnswers[key] = text;
      answerValues[key] = answerValueText(question, state) ?? text;
    }

    return {
      questions: this.questions,
      answers,
      displayAnswers,
      answerValues,
      containsFreeText,
      freeTextIntents,
      cancelled: false,
    };
  }

  private renderTabBar(add: (text: string) => void): void {
    const parts = [" "];

    for (let i = 0; i < this.questions.length; i++) {
      const tab = questionTabDisplay(this.questions[i], this.states[i]);
      if (i === this.activeTab) {
        parts.push(this.theme.bg("selectedBg", this.theme.fg("text", tab.label)));
      } else {
        parts.push(this.theme.fg(tab.color, tab.label));
      }
    }

    const submitLabel = " Submit ";
    const submitActive = this.activeTab === this.questions.length;
    parts.push(
      submitActive
        ? this.theme.bg("selectedBg", this.theme.fg("text", submitLabel))
        : this.allReadyToSubmit()
          ? this.theme.fg("success", submitLabel)
          : this.theme.fg("dim", submitLabel),
    );

    add(parts.join(""));
  }

  private renderOption(
    question: Question,
    state: QuestionState,
    option: DisplayOption,
    index: number,
    width: number,
    add: (text: string) => void,
  ): void {
    const selected = index === state.cursorIndex;
    const prefix = selected ? this.theme.fg("accent", ">") : " ";
    const specialKind = option.specialKind;
    const specialValue = specialKind && state.freeText?.intent === specialKind ? state.freeText.value : null;
    const editingThis = specialKind !== undefined && state.editingIntent === specialKind;
    const labelColor = specialKind
      ? selected
        ? "accent"
        : specialKind === "clarification_request"
          ? "warning"
          : "muted"
      : selected
        ? "accent"
        : "text";

    let markerText = question.multiSelect ? "[ ]" : "( )";
    let markerColor: "dim" | "success" | "warning" | "accent" = "dim";
    if (specialKind === "clarification_request") {
      markerText = "[ask]";
      markerColor = specialValue ? "warning" : "dim";
    } else if (specialKind === "answer") {
      markerText = "[text]";
      markerColor = specialValue ? "success" : "dim";
    } else if (question.multiSelect) {
      if (state.selectedIndices.has(index)) {
        markerText = "[x]";
        markerColor = "accent";
      }
    } else if (state.selectedIndex === index) {
      markerText = "(x)";
      markerColor = "success";
    }

    const marker = this.theme.fg(markerColor, markerText);
    add(
      `${prefix} ${marker} ${this.theme.fg(labelColor, `${index + 1}. ${option.label}`)}` +
        (editingThis ? this.theme.fg("accent", " (editing)") : ""),
    );

    const indent = " ".repeat(markerText.length + 3);
    if (option.description) {
      for (const line of wrapTextWithAnsi(this.theme.fg("muted", option.description), width - indent.length)) {
        add(`${indent}${line}`);
      }
    }
    if (specialValue && !editingThis) {
      const color = specialKind === "clarification_request" ? "warning" : "dim";
      for (const line of wrapTextWithAnsi(this.theme.fg(color, `Current: "${specialValue}"`), width - indent.length)) {
        add(`${indent}${line}`);
      }
    }
  }

  private renderQuestionBody(
    question: Question,
    state: QuestionState,
    width: number,
    add: (text: string) => void,
  ): void {
    for (const line of wrapTextWithAnsi(this.theme.fg("text", ` ${question.question}`), width - 2)) {
      add(line);
    }
    add("");

    const options = this.allOptions(question);
    options.forEach((option, index) => this.renderOption(question, state, option, index, width, add));

    if (state.editingIntent) {
      add("");
      add(
        this.theme.fg(
          "muted",
          state.editingIntent === "clarification_request"
            ? " Your clarification:"
            : " Your answer:",
        ),
      );
      for (const line of this.editor.render(width - 4)) add(` ${line}`);
    }

    add("");
    const error = validationError(question, state);
    if (!state.editingIntent && error !== null && (state.confirmed || hasAnswer(question, state))) {
      add(this.theme.fg("warning", ` ${error}`));
      add("");
    }

    if (state.editingIntent) {
      add(this.theme.fg("dim", " Enter submit | Esc back"));
      return;
    }
    const selectedOption = options[state.cursorIndex];
    const specialKind = selectedOption?.specialKind;
    const tabHint = this.isSingle
      ? ""
      : specialKind
        ? " | Left/Right switch tabs"
        : " | Tab/Left/Right switch tabs";
    const actionHint = specialKind
      ? state.freeText?.intent === specialKind
        ? "Enter confirm | Space/Tab edit"
        : "Space/Tab open editor"
      : question.multiSelect
        ? "Space toggle | Enter confirm"
        : "Enter select";
    add(this.theme.fg("dim", ` Up/Down navigate | ${actionHint}${tabHint} | Esc cancel`));
  }

  private renderSubmitTab(add: (text: string) => void): void {
    const allDone = this.allReadyToSubmit();
    add(
      allDone
        ? this.theme.fg("success", this.theme.bold(" Ready to submit"))
        : this.theme.fg("warning", this.theme.bold(" Unanswered questions")),
    );
    add("");

    for (let i = 0; i < this.questions.length; i++) {
      const question = this.questions[i];
      const state = this.states[i];
      const header = questionTabHeader(question);
      const displayState = questionDisplayState(question, state);
      const badge = questionSummaryBadge(question, state);
      const text = answerText(question, state);
      const value = text ?? (displayState === "skipped" ? "(skipped)" : "(no answer)");
      const valueColor =
        displayState === "clarification"
          ? "warning"
          : displayState === "answered"
            ? "text"
            : displayState === "skipped"
              ? "dim"
              : "warning";
      add(
        ` ${this.theme.fg(badge.color, badge.label)} ` +
          this.theme.fg("accent", `${header}: `) +
          this.theme.fg(valueColor, value),
      );
    }
    add("");
    if (allDone) {
      add(this.theme.fg("success", " Press Enter to submit"));
    } else {
      const missing = this.questions
        .map((question, index) => {
          if (isSatisfied(question, this.states[index])) return null;
          const reason = validationError(question, this.states[index]);
          const header = questionTabHeader(question);
          return reason ? `${header} (${reason})` : header;
        })
        .filter((value): value is string => value !== null)
        .join(", ");
      add(this.theme.fg("warning", ` Still needed: ${missing}`));
    }

    add("");
    add(this.theme.fg("dim", " Left/Right switch tabs | Enter jump to unanswered | Esc cancel"));
  }
  render(width: number): string[] {
    if (this.questions.length === 0) return [];
    const lines: string[] = [];
    const add = (text: string) => lines.push(truncateToWidth(text, width));
    add(this.theme.fg("accent", "-".repeat(width)));
    if (!this.isSingle) {
      this.renderTabBar(add);
      lines.push("");
    }
    const question = this.questions[this.activeTab];
    if (question) this.renderQuestionBody(question, this.states[this.activeTab], width, add);
    else this.renderSubmitTab(add);
    add(this.theme.fg("accent", "-".repeat(width)));
    return lines;
  }

  handleInput(data: string): void {
    if (this.resolved) return;

    if (!this.isSingle && this.activeTab === this.questions.length) {
      if (matchesKey(data, Key.enter)) {
        if (this.allReadyToSubmit()) this.submit();
        else {
          this.activeTab = this.firstUnsatisfiedTab() ?? 0;
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) return this.cancel();
      if (matchesKey(data, Key.right)) {
        this.activeTab = 0;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.left)) {
        this.activeTab = this.questions.length - 1;
        this.tui.requestRender();
      }
      return;
    }

    const question = this.currentQuestion();
    const state = this.currentState();
    if (state.editingIntent) {
      if (matchesKey(data, Key.escape)) return this.exitEditMode(false);
      if (matchesKey(data, Key.enter)) {
        this.exitEditMode(true);
        if (!question.multiSelect) {
          if (state.freeText !== null || !questionIsRequired(question)) this.confirmAndAdvance();
          else this.tui.requestRender();
        }
        return;
      }
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      if (!this.isSingle && this.hasAnyAnswers()) {
        this.activeTab = this.questions.length;
        this.tui.requestRender();
      } else {
        this.cancel();
      }
      return;
    }

    if (!this.isSingle && matchesKey(data, Key.right)) {
      this.autoConfirmIfAnswered();
      this.activeTab = (this.activeTab + 1) % this.totalTabs;
      this.tui.requestRender();
      return;
    }

    if (!this.isSingle && matchesKey(data, Key.left)) {
      this.autoConfirmIfAnswered();
      this.activeTab = (this.activeTab - 1 + this.totalTabs) % this.totalTabs;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      state.cursorIndex = (state.cursorIndex - 1 + this.allOptions(question).length) % this.allOptions(question).length;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      state.cursorIndex = (state.cursorIndex + 1) % this.allOptions(question).length;
      this.tui.requestRender();
      return;
    }

    const selectedOption = this.allOptions(question)[state.cursorIndex];
    const specialKind = selectedOption?.specialKind;

    if (specialKind) {
      if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
        this.enterEditMode(specialKind);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (state.freeText?.intent === specialKind) this.confirmAndAdvance();
        else this.enterEditMode(specialKind);
        return;
      }
    }

    if (!this.isSingle && !specialKind && matchesKey(data, Key.tab)) {
      this.autoConfirmIfAnswered();
      this.activeTab = (this.activeTab + 1) % this.totalTabs;
      this.tui.requestRender();
      return;
    }

    if (question.multiSelect) {
      if (matchesKey(data, Key.space) && !specialKind) return this.toggleSelected(state.cursorIndex);
      if (matchesKey(data, Key.enter) && !specialKind) return this.confirmAndAdvance();
      return;
    }

    if (matchesKey(data, Key.enter) && !specialKind) {
      state.selectedIndex = state.cursorIndex;
      state.freeText = null;
      markStateDirty(question, state);
      this.confirmAndAdvance();
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
Options may be bare strings or objects with label/value/description.
Set multiSelect: true when more than one option can validly apply at the same time. It defaults to false.
The header field is optional; when omitted, the tool uses question.id or a shortened question text in the tab bar.
Optional fields:
- question.id for stable answer keys
- option.value for stable machine values in details.answerValues
- required/minSelections/maxSelections for validation
- allowFreeText to hide the built-in editor options (default true)
- echoFreeTextInContent to include free-text answers in content output (default false)
When free text is allowed, the UI provides built-in "Type your own answer..." and "Ask a clarification question first..." options.
If the user asks for clarification instead of answering, respond to that clarification in normal assistant text and do not call this tool again for it.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,
    parameters: InputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = normalizeInput(params as Input);
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: ask_user_question requires an interactive session." }],
          details: cancelledResult(input.questions),
        };
      }
      const result = await ctx.ui.custom<Result | null>(
        (tui, theme, _kb, done) => new AskUserQuestionComponent(input.questions, tui, theme, done),
      );
      if (result === null || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: cancelledResult(input.questions),
        };
      }
      const details: Result = {
        ...result,
        displayAnswers: buildDisplayAnswers(result, input.echoFreeTextInContent === true),
      };

      return {
        content: [{ type: "text", text: buildToolContent(details) }],
        details,
      };
    },

    renderCall(args, theme) {
      const questions = ((args as { questions?: QuestionInput[] }).questions ?? []) as QuestionInput[];
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("ask user ")) +
          theme.fg("muted", questions.map((question) => questionTabHeader(question)).join(", ")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;
      if (!details) {
        const text = result.content[0];
        return new TruncatedText(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);

      const keys = questionKeys(details.questions);
      const lines = details.questions.map((question, index) => {
        const key = keys[index];
        const answer = details.displayAnswers[key] ?? details.answers[key];
        const clarification = details.freeTextIntents[key] === "clarification_request";
        const skipped = answer === undefined && question.required === false;
        const badge = clarification ? "[ask]" : skipped ? "[skip]" : answer === undefined ? "[pending]" : "[done]";
        const badgeColor = clarification ? "warning" : skipped ? "dim" : answer === undefined ? "warning" : "success";
        const value = answer ?? (skipped ? "(skipped)" : "(no answer)");
        const valueColor = clarification ? "warning" : skipped ? "dim" : answer === undefined ? "warning" : "text";
        return (
          theme.fg(badgeColor, `${badge} `) +
          theme.fg("accent", `${questionHeader(question)}: `) +
          theme.fg(valueColor, value)
        );
      });

      return new TruncatedText(lines.join("\n"), 0, 0);
    },
  });
}
