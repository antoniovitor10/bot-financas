import type { InstallmentsInput, ParsedTransaction, Periodicity, RecurrenceInput, TransactionType } from "../types/finance.js";
import { parseDatePt, todayIso } from "../utils/dates.js";
import { extractAmountCents } from "./amount-parser.js";
import { signedAmount } from "../utils/money.js";

const INCOME_HINTS = /\b(recebi|receita|sal[aá]rio|pix recebido|entrada|rendimento|reembolso recebido|deposito|dep[oó]sito)\b/i;
const EXPENSE_HINTS = /\b(gastei|paguei|compra|comprei|despesa|sa[ií]da|mercado|almo[cç]o|jantar|lanche|uber|ifood|farm[aá]cia|gasolina)\b/i;

const PAID_HINTS = /\b(paguei|pago|quitado|quitei|comprei|gastei|recebi|recebido)\b/i;
const UNPAID_HINTS = /\b(vence|vencimento|a vencer|pagar|conta de|boleto|fatura|d[eÃ©]bito futuro|debito futuro)\b/i;

const PERIODICITY_PATTERNS: Array<[RegExp, Periodicity]> = [
  [/\b(todo m[eê]s|mensal|mensalmente|fix[oa]|recorrente|assinatura)\b/i, "monthly"],
  [/\b(anual|todo ano|anualmente)\b/i, "yearly"],
  [/\b(semanal|toda semana|semanalmente)\b/i, "weekly"],
  [/\b(quinzenal|a cada quinzena)\b/i, "biweekly"],
  [/\b(bimestral)\b/i, "bimonthly"],
  [/\b(trimestral)\b/i, "trimonthly"]
];

function detectType(text: string): TransactionType {
  if (INCOME_HINTS.test(text)) return "income";
  if (EXPENSE_HINTS.test(text)) return "expense";
  return "expense";
}

function detectPeriodicity(text: string): Periodicity | undefined {
  for (const [pattern, periodicity] of PERIODICITY_PATTERNS) {
    if (pattern.test(text)) return periodicity;
  }
  return undefined;
}

function detectInstallments(text: string): InstallmentsInput | undefined {
  const match = text.match(
    /\b(?:em\s*)?(\d{1,2})\s*x\b|\b(?:em|parcelad[oa]\s+em|dividid[oa]\s+por)\s+(\d{1,2})\s+(?:parcelas|vezes)\b/i
  );
  const total = Number(match?.[1] || match?.[2]);
  if (!Number.isFinite(total) || total <= 1) return undefined;
  return {
    periodicity: detectPeriodicity(text) || "monthly",
    total
  };
}

function detectRecurrence(text: string): RecurrenceInput | undefined {
  if (detectInstallments(text)) return undefined;
  const periodicity = detectPeriodicity(text);
  return periodicity ? { periodicity } : undefined;
}

function detectPaid(text: string, date?: string): boolean {
  if (PAID_HINTS.test(text)) return true;
  if (UNPAID_HINTS.test(text)) return false;
  return date ? date <= todayIso() : true;
}

function cleanDescription(text: string): string | undefined {
  const withoutAmount = focusDescription(text)
    .replace(/\b(?:dividid[oa]\s+por|parcelad[oa]\s+em|em)\s+\d{1,2}\s*(?:x|parcelas|vezes)\b/gi, " ")
    .replace(/\b\d{1,2}\s*x\b/gi, " ")
    .replace(/(?:r\$\s*)?[+-]?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?(?:\s*(?:reais|real|brl))?/gi, " ")
    .replace(/\b(hoje|ontem|amanh[aã]|dia\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gi, " ")
    .replace(/\b(gastei|paguei|comprei|compra|recebi|receita|despesa|sa[ií]da|entrada|dia|usando|dividid[oa]|parcelad[oa]|parcela|parcelas|vezes|por|no|na|em|com|de|do|da|a|o|cart[aã]o|conta|categoria)\b/gi, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (withoutAmount.length >= 3) return withoutAmount.slice(0, 80);
  return undefined;
}

function focusDescription(text: string): string {
  let focused = text.trim();
  const amount = focused.match(/(?:r\$\s*)?\d+(?:[,.]\d{1,2})?(?:\s*(?:reais|real|brl))?/i);
  if (amount && amount.index !== undefined) {
    const before = focused.slice(0, amount.index).trim();
    const after = focused.slice(amount.index + amount[0].length).trim();
    focused = before && !/^(gastei|paguei|comprei|recebi)$/i.test(before) ? before : after;
  }

  focused = focused
    .replace(/\b(?:na|no|em)\s+categoria\b.*$/i, " ")
    .replace(/\bcategoria\b.*$/i, " ")
    .replace(/\b(?:usando|pela|pelo|na|no|em)\s+(?:a\s+)?conta\b.*$/i, " ")
    .replace(/\b(?:usando|pela|pelo|na|no|em)\s+(?:o\s+)?cart[aã]o\b.*$/i, " ")
    .replace(/\bcart[aã]o\s+de\s+cr[eé]dito\b.*$/i, " ")
    .replace(/\b(?:no|na)\s+(?:nubank|nu bank|picpay|pic pay|mercado pago|inter|c6|neon|will|amazon)\b.*$/i, " ")
    .trim();

  return focused || text;
}

function missingFields(transaction: ParsedTransaction): string[] {
  const missing: string[] = [];
  if (!transaction.description) missing.push("description");
  if (transaction.amount_cents === undefined) missing.push("amount_cents");
  if (!transaction.date) missing.push("date");
  return missing;
}

function confidenceFor(transaction: ParsedTransaction, originalText: string): number {
  let confidence = 0.35;
  if (transaction.amount_cents !== undefined) confidence += 0.2;
  if (transaction.date) confidence += 0.1;
  if (transaction.description) confidence += 0.15;
  if (INCOME_HINTS.test(originalText) || EXPENSE_HINTS.test(originalText)) confidence += 0.1;
  if (transaction.installments || transaction.recurrence) confidence += 0.05;
  return Math.min(confidence, 0.95);
}

export class TextParser {
  parse(text: string): ParsedTransaction {
    const type = detectType(text);
    const rawAmount = extractAmountCents(text);
    const amount = rawAmount === undefined ? undefined : signedAmount(type, rawAmount);
    const date = parseDatePt(text) || todayIso();
    const transaction: ParsedTransaction = {
      type,
      description: cleanDescription(text),
      amount_cents: amount,
      date,
      paid: detectPaid(text, date),
      recurrence: detectRecurrence(text),
      installments: detectInstallments(text),
      notes: text.trim(),
      confidence: 0,
      missing_fields: [],
      source: "text",
      raw_text: text
    };

    transaction.missing_fields = missingFields(transaction);
    transaction.confidence = confidenceFor(transaction, text);
    return transaction;
  }
}
