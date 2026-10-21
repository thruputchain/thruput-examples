import { expect, it } from "vitest";
import { percentage, validateDefinition, type Definition } from "./polls";

const draft = (): Definition => ({
  title: "Priorities",
  description: "",
  questions: [{ title: "What next?", options: ["Wallet", "Explorer"] }],
});

it("checks UTF-8 byte limits and duplicate options before signing", () => {
  const definition = draft();
  definition.questions[0]!.options = ["Wallet", " Wallet "];
  expect(validateDefinition(definition)).toContain("distinct");
  definition.questions[0]!.options = ["é".repeat(49), "Explorer"];
  expect(validateDefinition(definition)).toContain("96");
  definition.questions[0]!.options = ["é".repeat(48), "Explorer"];
  expect(validateDefinition(definition)).toBeNull();
  definition.title = "é".repeat(81);
  expect(validateDefinition(definition)).toContain("160");
});

it("allows an empty draft but rejects too many questions", () => {
  const definition = draft();
  definition.questions = [];
  expect(validateDefinition(definition)).toBeNull();
  definition.questions = Array.from({ length: 9 }, () => ({
    title: "Question",
    options: ["A", "B"],
  }));
  expect(validateDefinition(definition)).toContain("8");
});

it("formats zero and very large totals without bigint precision loss", () => {
  expect(percentage(0n, 0n)).toBe("0");
  expect(percentage(1n, 3n)).toBe("33.3");
  expect(percentage(10n ** 30n, 2n * 10n ** 30n)).toBe("50");
});
