import { firesInProtected } from "./firesInProtected.js";
import { flaring } from "./flaring.js";
import { forestLoss } from "./forestLoss.js";
import { methaneAnomaly } from "./methaneAnomaly.js";
import type { Rule } from "./types.js";
import { weatherExtreme } from "./weatherExtreme.js";

/** Every rule the kernel knows. Adding one = one import here + a plan note on its blind spots. */
export const RULES: ReadonlyMap<string, Rule> = new Map([forestLoss, firesInProtected, flaring, methaneAnomaly, weatherExtreme].map((r) => [r.name, r]));

export { defineRule, ToolError } from "./types.js";
export type { Rule, RuleContext, Candidate, Confirmation, ToolCall } from "./types.js";
