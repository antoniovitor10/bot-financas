import { parseAmountToCents } from "../utils/money.js";

export function extractAmountCents(text: string): number | undefined {
  return parseAmountToCents(text);
}
