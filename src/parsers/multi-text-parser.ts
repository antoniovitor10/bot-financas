import type { ParsedTransaction, TransactionSource } from "../types/finance.js";
import type { TextParser } from "./text-parser.js";

const AMOUNT_PATTERN = /(?:R\$\s*)?\d+(?:[,.]\d{1,2})?(?:\s*(?:reais|real))?/gi;

export class MultiTextParser {
  constructor(private readonly textParser: TextParser) {}

  parse(text: string, source: TransactionSource = "text"): ParsedTransaction[] {
    const parts = splitByAmount(text);
    if (parts.length <= 1) return [];

    return parts.map((part) => ({
      ...this.textParser.parse(part),
      source,
      raw_text: part,
      notes: `Trecho extraido do audio: ${part}`
    }));
  }
}

export function countAmounts(text: string): number {
  return Array.from(text.matchAll(AMOUNT_PATTERN))
    .filter((match) => !isDateLike(text, match.index || 0, match[0]))
    .length;
}

export function amountLooksPresent(text: string, amountCents?: number): boolean {
  if (amountCents === undefined) return false;
  const absolute = Math.abs(amountCents);
  return Array.from(text.matchAll(AMOUNT_PATTERN)).some((match) => {
    if (isDateLike(text, match.index || 0, match[0])) return false;
    return normalizeAmount(match[0]) === absolute;
  });
}

function splitByAmount(text: string): string[] {
  const matches = Array.from(text.matchAll(AMOUNT_PATTERN))
    .filter((match) => !isDateLike(text, match.index || 0, match[0]));
  if (matches.length <= 1) return [];

  const parts: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = index === 0 ? 0 : matches[index].index || 0;
    const nextIndex = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    const end = trimTrailingBoundary(text, index === 0 ? 0 : matches[index].index || 0, nextIndex);
    const part = text.slice(start, end).replace(/^\s*(?:e|,|\.|;)\s*/i, "").trim();
    if (part) parts.push(part);
  }

  return parts;
}

function trimTrailingBoundary(text: string, start: number, end: number): number {
  const segment = text.slice(start, end);
  const lastBoundary = Math.max(segment.lastIndexOf("."), segment.lastIndexOf(";"));
  return lastBoundary >= 0 ? start + lastBoundary + 1 : end;
}

function normalizeAmount(raw: string): number | undefined {
  const cleaned = raw
    .replace(/r\$/gi, "")
    .replace(/\s*(?:reais|real)\b/gi, "")
    .trim();
  const decimal = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const value = Number(decimal);
  return Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

function isDateLike(text: string, index: number, value: string): boolean {
  const before = text.slice(Math.max(0, index - 6), index);
  const after = text.slice(index + value.length, index + value.length + 3);
  return before.endsWith("/") || after.startsWith("/") || /\bdia\s*$/i.test(before);
}
