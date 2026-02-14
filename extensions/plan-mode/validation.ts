import { extractTodoItems, type TodoItem } from "./utils";

export const REQUIRED_PLAN_SECTIONS = ["Goal", "Scope", "Assumptions", "Plan", "Risks", "Validation"] as const;
export type RequiredPlanSection = (typeof REQUIRED_PLAN_SECTIONS)[number];

export interface PlanValidationResult {
	valid: boolean;
	missingSections: RequiredPlanSection[];
	duplicateSections: RequiredPlanSection[];
	hasNumberedPlanSteps: boolean;
	todoItems: TodoItem[];
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPlanSectionRegex(section: RequiredPlanSection, global = false): RegExp {
	return new RegExp(
		`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:\\*{1,2})?${escapeRegex(section)}(?:\\*{1,2})?\\s*:`,
		global ? "gim" : "im",
	);
}

function countPlanSectionOccurrences(text: string, section: RequiredPlanSection): number {
	const pattern = buildPlanSectionRegex(section, true);
	return Array.from(text.matchAll(pattern)).length;
}

export function validatePlanOutput(text: string): PlanValidationResult {
	const sectionCounts = {} as Record<RequiredPlanSection, number>;
	for (const section of REQUIRED_PLAN_SECTIONS) {
		sectionCounts[section] = countPlanSectionOccurrences(text, section);
	}

	const missingSections = REQUIRED_PLAN_SECTIONS.filter((section) => sectionCounts[section] === 0);
	const duplicateSections = REQUIRED_PLAN_SECTIONS.filter((section) => sectionCounts[section] > 1);
	const todoItems = extractTodoItems(text);
	const hasNumberedPlanSteps = todoItems.length > 0;

	return {
		valid: text.trim().length !== 0,
		missingSections,
		duplicateSections,
		hasNumberedPlanSteps,
		todoItems,
	};
}
