import type { AskQuestion } from "./protocol.js";

/** The UI and provider adapter validate the same values before accepting a form. */
export function questionError(question: AskQuestion, values: string[]): string | undefined {
  if (values.length === 0 || values.every((value) => value.trim() === "")) {
    return question.required === false ? undefined : "An answer is required.";
  }
  if (!question.multiSelect && values.length > 1) return "Choose one answer.";
  const value = values[0]!;
  if (question.inputType === "number" || question.inputType === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) return "Enter a number.";
    if (question.inputType === "integer" && !Number.isInteger(number)) return "Enter a whole number.";
    if (question.minimum !== undefined && number < question.minimum) return `Minimum: ${question.minimum}.`;
    if (question.maximum !== undefined && number > question.maximum) return `Maximum: ${question.maximum}.`;
  }
  if (question.minLength !== undefined && value.length < question.minLength) return `Use at least ${question.minLength} characters.`;
  if (question.maxLength !== undefined && value.length > question.maxLength) return `Use at most ${question.maxLength} characters.`;
  if (question.inputType === "boolean" && !["true", "false"].includes(value)) return "Choose yes or no.";
  if (question.allowOther === false && question.options.length > 0 && values.some((value) =>
    !question.options.some((option) => (option.value ?? option.label) === value))) return "Choose an offered option.";
  return undefined;
}
