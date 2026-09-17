export type ExploreFormula = {
  expression: string;
  inputs: { name: string; cardId: string }[];
  prefix?: string;
  suffix?: string;
};

export const EXPLORE_FORMULA_MAX_LENGTH = 2_000;
export const EXPLORE_FORMULA_MAX_INPUTS = 32;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const RESERVED_NAMES = new Set(["constructor", "prototype", "__proto__"]);
const FUNCTIONS = new Set(["SUM", "AVG", "MIN", "MAX"]);

type Symbol = "+" | "-" | "*" | "/" | "(" | ")" | ",";
type Token = { kind: "number" | "name" | Symbol | "end"; text: string; position: number };
type Expression =
  | { kind: "number"; value: number }
  | { kind: "input"; name: string }
  | { kind: "unary"; operator: "+" | "-"; operand: Expression }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/"; left: Expression; right: Expression }
  | { kind: "call"; name: string; args: Expression[] };

function syntaxError(message: string, token: Token): Error {
  return new Error(`${message} (position ${token.position + 1}).`);
}

function tokenize(expression: string): Token[] {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("Enter a formula, such as A + B.");
  }
  if (expression.length > EXPLORE_FORMULA_MAX_LENGTH) {
    throw new Error(`Formulas can contain at most ${EXPLORE_FORMULA_MAX_LENGTH} characters.`);
  }
  const tokens: Token[] = [];
  let position = 0;
  while (position < expression.length) {
    const char = expression[position];
    if (/\s/.test(char)) {
      position += 1;
      continue;
    }
    const remaining = expression.slice(position);
    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remaining);
    const name = numeric ? null : /^[A-Za-z][A-Za-z0-9_]*/.exec(remaining);
    if (numeric) {
      if (!Number.isFinite(Number(numeric[0]))) {
        throw new Error("Formula numbers must be finite.");
      }
      tokens.push({ kind: "number", text: numeric[0], position });
      position += numeric[0].length;
    } else if (name) {
      tokens.push({ kind: "name", text: name[0], position });
      position += name[0].length;
    } else if ("+-*/(),".includes(char)) {
      tokens.push({ kind: char as Symbol, text: char, position });
      position += 1;
    } else {
      throw new Error(`Unexpected character "${char}" at position ${position + 1}.`);
    }
    if (tokens.length > MAX_TOKENS) {
      throw new Error("This formula is too complex. Use fewer terms.");
    }
  }
  tokens.push({ kind: "end", text: "", position });
  return tokens;
}

/** A bounded arithmetic grammar shared by the editor and the API; never JavaScript. */
class FormulaParser {
  private index = 0;
  readonly references = new Set<string>();

  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const expression = this.parseSum(0);
    if (this.current().kind !== "end") {
      throw syntaxError(
        `Unexpected "${this.current().text}"; add an operator between values`,
        this.current(),
      );
    }
    return expression;
  }

  private current(): Token {
    return this.tokens[this.index];
  }

  private parseSum(depth: number): Expression {
    let left = this.parseProduct(depth);
    while (this.current().kind === "+" || this.current().kind === "-") {
      const operator = this.current().kind as "+" | "-";
      this.index += 1;
      left = { kind: "binary", operator, left, right: this.parseProduct(depth) };
    }
    return left;
  }

  private parseProduct(depth: number): Expression {
    let left = this.parseUnary(depth);
    while (this.current().kind === "*" || this.current().kind === "/") {
      const operator = this.current().kind as "*" | "/";
      this.index += 1;
      left = { kind: "binary", operator, left, right: this.parseUnary(depth) };
    }
    return left;
  }

  private parseUnary(depth: number): Expression {
    if (depth > MAX_DEPTH) {
      throw new Error(
        `Formulas can nest parentheses, functions, or signs at most ${MAX_DEPTH} times.`,
      );
    }
    const token = this.current();
    if (token.kind === "+" || token.kind === "-") {
      this.index += 1;
      return { kind: "unary", operator: token.kind, operand: this.parseUnary(depth + 1) };
    }
    if (token.kind === "number") {
      this.index += 1;
      return { kind: "number", value: Number(token.text) };
    }
    if (token.kind === "(") {
      this.index += 1;
      const expression = this.parseSum(depth + 1);
      this.closeParenthesis();
      return expression;
    }
    if (token.kind === "name") {
      this.index += 1;
      if (this.current().kind !== "(") {
        this.references.add(token.text);
        return { kind: "input", name: token.text };
      }
      const name = token.text.toUpperCase();
      if (!FUNCTIONS.has(name)) {
        throw syntaxError(`Unknown function "${token.text}". Use SUM, AVG, MIN, or MAX`, token);
      }
      this.index += 1;
      if (this.current().kind === ")") {
        throw syntaxError(`${name} needs at least one value`, this.current());
      }
      const args = [this.parseSum(depth + 1)];
      while (this.current().kind === ",") {
        this.index += 1;
        args.push(this.parseSum(depth + 1));
      }
      this.closeParenthesis();
      return { kind: "call", name, args };
    }
    throw syntaxError("Expected a number, input name, or opening parenthesis", token);
  }

  private closeParenthesis(): void {
    if (this.current().kind !== ")") {
      throw syntaxError("Expected a closing parenthesis", this.current());
    }
    this.index += 1;
  }
}

function parseFormula(expression: string): { root: Expression; references: string[] } {
  const parser = new FormulaParser(tokenize(expression));
  const root = parser.parse();
  return { root, references: [...parser.references] };
}

/** Validates the complete syntax without reading or calculating widget values. */
export function getFormulaReferences(expression: string): string[] {
  return parseFormula(expression).references;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("The formula result is not a finite number.");
  }
  return value;
}

function evaluate(expression: Expression, values: Record<string, number>): number {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "input": {
      if (!Object.prototype.hasOwnProperty.call(values, expression.name)) {
        throw new Error(`Input "${expression.name}" has no value.`);
      }
      const value = values[expression.name];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Input "${expression.name}" must contain a finite number.`);
      }
      return value;
    }
    case "unary": {
      const value = evaluate(expression.operand, values);
      return expression.operator === "-" ? -value : value;
    }
    case "binary": {
      const left = evaluate(expression.left, values);
      const right = evaluate(expression.right, values);
      switch (expression.operator) {
        case "+":
          return finite(left + right);
        case "-":
          return finite(left - right);
        case "*":
          return finite(left * right);
        case "/":
          if (right === 0) throw new Error("Cannot divide by zero.");
          return finite(left / right);
      }
      break;
    }
    case "call": {
      const args = expression.args.map((arg) => evaluate(arg, values));
      switch (expression.name) {
        case "SUM":
          return finite(args.reduce((sum, value) => finite(sum + value), 0));
        case "AVG":
          return finite(args.reduce((sum, value) => sum + value / args.length, 0));
        case "MIN":
          return Math.min(...args);
        case "MAX":
          return Math.max(...args);
      }
    }
  }
  throw new Error("Unknown formula operation.");
}

export function evaluateFormula(expression: string, values: Record<string, number>): number {
  return evaluate(parseFormula(expression).root, values);
}

/** Checks stored configuration independently of transient input values and errors. */
export function validateFormula(formula: ExploreFormula): void {
  if (!formula || typeof formula !== "object" || Array.isArray(formula)) {
    throw new Error("A formula configuration is required.");
  }
  const references = getFormulaReferences(formula.expression);
  if (!Array.isArray(formula.inputs) || formula.inputs.length > EXPLORE_FORMULA_MAX_INPUTS) {
    throw new Error(`Choose at most ${EXPLORE_FORMULA_MAX_INPUTS} formula inputs.`);
  }
  const names = new Set<string>();
  for (const input of formula.inputs) {
    if (
      !input ||
      typeof input.name !== "string" ||
      !INPUT_NAME.test(input.name) ||
      RESERVED_NAMES.has(input.name)
    ) {
      throw new Error(
        "Input names must start with a letter and contain at most 32 letters, numbers, or underscores.",
      );
    }
    if (names.has(input.name))
      throw new Error(`Input name "${input.name}" is used more than once.`);
    if (typeof input.cardId !== "string" || !input.cardId.trim() || input.cardId.length > 200) {
      throw new Error(`Choose a widget for input "${input.name}".`);
    }
    names.add(input.name);
  }
  for (const reference of references) {
    if (!names.has(reference)) throw new Error(`Choose a widget for input "${reference}".`);
  }
  const referencedNames = new Set(references);
  for (const name of names) {
    if (!referencedNames.has(name)) throw new Error(`Input "${name}" is not used in the formula.`);
  }
  for (const field of ["prefix", "suffix"] as const) {
    if (
      formula[field] !== undefined &&
      (typeof formula[field] !== "string" || formula[field].length > 32)
    ) {
      throw new Error(`The formula ${field} can contain at most 32 characters.`);
    }
  }
}
