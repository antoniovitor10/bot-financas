import type { ParsedTransaction } from "../types/finance.js";

function dateDistanceDays(a: string, b: string): number {
  const left = new Date(`${a}T00:00:00Z`).getTime();
  const right = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(left - right) / 86_400_000;
}

function normalizeText(value: string | undefined): string[] {
  return (value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function descriptionSimilarity(left: string | undefined, right: string | undefined): number {
  const leftTokens = new Set(normalizeText(left));
  const rightTokens = new Set(normalizeText(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

export type ExistingTransactionForDuplicate = {
  id: number;
  date: string;
  amount_cents: number;
  description: string;
  account_id?: number;
  account_type?: string;
  credit_card_id?: number | null;
};

function isSameCreditCard(transaction: ParsedTransaction, existing: ExistingTransactionForDuplicate): boolean {
  if (transaction.credit_card_id === undefined) return false;
  return (
    existing.credit_card_id === transaction.credit_card_id ||
    existing.account_id === transaction.credit_card_id ||
    (existing.account_type === "CreditCard" && existing.account_id === transaction.credit_card_id)
  );
}

export function findDuplicate(transaction: ParsedTransaction, existing: ExistingTransactionForDuplicate[]) {
  if (!transaction.date || transaction.amount_cents === undefined) return undefined;

  return existing
    .filter((existingTransaction) => (
      existingTransaction.amount_cents === transaction.amount_cents &&
      dateDistanceDays(existingTransaction.date, transaction.date as string) <= 21
    ))
    .map((existingTransaction) => ({
      transaction: existingTransaction,
      days: dateDistanceDays(existingTransaction.date, transaction.date as string),
      similarity: descriptionSimilarity(existingTransaction.description, transaction.description),
      sameCreditCard: isSameCreditCard(transaction, existingTransaction)
    }))
    .map((candidate) => ({
      ...candidate,
      nearbyMatch: candidate.days <= 3 && (candidate.similarity >= 0.25 || candidate.days <= 1),
      shiftedCardInvoiceMatch: candidate.sameCreditCard && candidate.days <= 21 && candidate.similarity >= 0.2
    }))
    .filter((candidate) => candidate.nearbyMatch || candidate.shiftedCardInvoiceMatch)
    .sort((left, right) => {
      const leftRank = left.nearbyMatch ? 2 : 1;
      const rightRank = right.nearbyMatch ? 2 : 1;
      return rightRank - leftRank || left.days - right.days || right.similarity - left.similarity;
    })[0]?.transaction;
}
