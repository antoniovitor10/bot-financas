import type { DbConnection } from "./db.js";
import type { ParsedTransaction } from "../types/finance.js";

export interface LearnedTransactionPattern {
  pattern: string;
  sample_description: string;
  category_id?: number;
  category_name?: string;
  account_id?: number;
  account_name?: string;
  credit_card_id?: number;
  credit_card_name?: string;
  seen_count: number;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface LearnedTransactionPatternRow {
  pattern: string;
  sample_description: string;
  category_id: number | null;
  category_name: string | null;
  account_id: number | null;
  account_name: string | null;
  credit_card_id: number | null;
  credit_card_name: string | null;
  seen_count: number;
  confidence: number;
  created_at: string;
  updated_at: string;
}

const STOP_WORDS = new Set([
  "a",
  "ao",
  "as",
  "com",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "hoje",
  "na",
  "nas",
  "no",
  "nos",
  "ontem",
  "para",
  "por",
  "r",
  "rs",
  "um",
  "uma"
]);

const FIELD_HINTS = new Set([
  "categoria",
  "cartao",
  "cartao de credito",
  "conta",
  "credito",
  "debito",
  "pago",
  "paguei",
  "valor",
  "vencimento",
  "vence"
]);

export class LearningRepo {
  constructor(private readonly db: DbConnection) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_transaction_patterns (
        pattern TEXT PRIMARY KEY,
        sample_description TEXT NOT NULL,
        category_id INTEGER,
        category_name TEXT,
        account_id INTEGER,
        account_name TEXT,
        credit_card_id INTEGER,
        credit_card_name TEXT,
        seen_count INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  learn(transaction: ParsedTransaction): void {
    const pattern = patternFromTransaction(transaction);
    if (!pattern) return;
    if (!transaction.category_id && !transaction.account_id && !transaction.credit_card_id) return;

    this.db
      .prepare(`
        INSERT INTO learned_transaction_patterns (
          pattern,
          sample_description,
          category_id,
          category_name,
          account_id,
          account_name,
          credit_card_id,
          credit_card_name,
          seen_count,
          confidence,
          created_at,
          updated_at
        )
        VALUES (
          @pattern,
          @sampleDescription,
          @categoryId,
          @categoryName,
          @accountId,
          @accountName,
          @creditCardId,
          @creditCardName,
          1,
          @confidence,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(pattern) DO UPDATE SET
          sample_description = excluded.sample_description,
          category_id = COALESCE(excluded.category_id, learned_transaction_patterns.category_id),
          category_name = COALESCE(excluded.category_name, learned_transaction_patterns.category_name),
          account_id = COALESCE(excluded.account_id, learned_transaction_patterns.account_id),
          account_name = COALESCE(excluded.account_name, learned_transaction_patterns.account_name),
          credit_card_id = COALESCE(excluded.credit_card_id, learned_transaction_patterns.credit_card_id),
          credit_card_name = COALESCE(excluded.credit_card_name, learned_transaction_patterns.credit_card_name),
          seen_count = learned_transaction_patterns.seen_count + 1,
          confidence = MIN(0.99, MAX(learned_transaction_patterns.confidence, excluded.confidence) + 0.04),
          updated_at = CURRENT_TIMESTAMP
      `)
      .run({
        pattern,
        sampleDescription: transaction.description || transaction.raw_text || pattern,
        categoryId: transaction.category_id ?? null,
        categoryName: transaction.category_name ?? null,
        accountId: transaction.credit_card_id ? null : transaction.account_id ?? null,
        accountName: transaction.credit_card_id ? null : transaction.account_name ?? null,
        creditCardId: transaction.credit_card_id ?? null,
        creditCardName: transaction.credit_card_name ?? null,
        confidence: Math.max(0.7, Math.min(0.99, transaction.confidence || 0.7))
      });
  }

  findMatch(text: string): LearnedTransactionPattern | undefined {
    const normalized = normalizeLearningText(text);
    if (!normalized) return undefined;

    const rows = this.db
      .prepare(`
        SELECT *
        FROM learned_transaction_patterns
        ORDER BY confidence DESC, seen_count DESC, length(pattern) DESC
      `)
      .all() as LearnedTransactionPatternRow[];

    for (const row of rows) {
      if (matchesPattern(normalized, row.pattern)) return toPattern(row);
    }
    return undefined;
  }

  list(limit = 30): LearnedTransactionPattern[] {
    return (this.db
      .prepare(`
        SELECT *
        FROM learned_transaction_patterns
        ORDER BY confidence DESC, seen_count DESC, updated_at DESC
        LIMIT ?
      `)
      .all(limit) as LearnedTransactionPatternRow[]).map(toPattern);
  }

  forget(input: string): boolean {
    const pattern = normalizePattern(input);
    if (!pattern) return false;
    const result = this.db
      .prepare("DELETE FROM learned_transaction_patterns WHERE pattern = ?")
      .run(pattern);
    return result.changes > 0;
  }

  normalizePattern(input: string): string {
    return normalizePattern(input);
  }
}

function toPattern(row: LearnedTransactionPatternRow): LearnedTransactionPattern {
  return {
    pattern: row.pattern,
    sample_description: row.sample_description,
    category_id: row.category_id ?? undefined,
    category_name: row.category_name ?? undefined,
    account_id: row.account_id ?? undefined,
    account_name: row.account_name ?? undefined,
    credit_card_id: row.credit_card_id ?? undefined,
    credit_card_name: row.credit_card_name ?? undefined,
    seen_count: row.seen_count,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function patternFromTransaction(transaction: ParsedTransaction): string {
  return normalizePattern(transaction.description || transaction.raw_text || "");
}

function normalizePattern(input: string): string {
  const normalized = normalizeLearningText(input)
    .replace(/\b\d+[,.]?\d*\b/g, " ")
    .replace(/\b(?:dia|em|no|na)?\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !FIELD_HINTS.has(token));
  return tokens.slice(0, 8).join(" ").slice(0, 90).trim();
}

function normalizeLearningText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s,./-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesPattern(normalizedText: string, pattern: string): boolean {
  if (pattern.length < 3) return false;
  if (` ${normalizedText} `.includes(` ${pattern} `)) return true;

  const patternTokens = pattern.split(" ").filter(Boolean);
  if (patternTokens.length === 0) return false;
  const textTokens = new Set(normalizedText.split(" ").filter(Boolean));
  return patternTokens.every((token) => textTokens.has(token));
}
