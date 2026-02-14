import { extractTodoItems, type TodoItem } from "./utils";

export interface PlanValidationResult {
	valid: boolean;
	missingSections: string[];
	duplicateSections: string[];
	hasNumberedPlanSteps: boolean;
	todoItems: TodoItem[];
}

export function validatePlanOutput(text: string): PlanValidationResult {
	const todoItems = extractTodoItems(text);
	const hasNumberedPlanSteps = todoItems.length > 0;

	return {
		valid: text.trim().length !== 0,
		missingSections: [],
		duplicateSections: [],
		hasNumberedPlanSteps,
		todoItems,
	};
}
