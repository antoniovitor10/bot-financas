import type { ImportBatch, ImportCandidate, OfxTransaction, ParsedTransaction } from "../types/finance.js";
import type { OrganizzeApiService } from "./organizze-api.js";
import type { Categorizer } from "./categorizer.js";
import type { PendingRepo } from "../repositories/pending-repo.js";
import type { OpenRouterImportService } from "./openrouter-import.js";
import { OfxParser } from "../parsers/ofx-parser.js";
import { CsvParser } from "../parsers/csv-parser.js";
import { extractPdfText } from "../parsers/pdf-text.js";
import { NubankPdfParser } from "../parsers/nubank-pdf-parser.js";
import { PicPayPdfParser } from "../parsers/picpay-pdf-parser.js";

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

type ExistingTransactionForDuplicate = {
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

function toParsed(ofx: OfxTransaction): ParsedTransaction {
  return {
    type: ofx.amount_cents < 0 ? "expense" : "income",
    description: ofx.description.slice(0, 80),
    amount_cents: ofx.amount_cents,
    date: ofx.date,
    notes: ofx.memo || `OFX FITID: ${ofx.fit_id || "sem fitid"}`,
    confidence: 0.75,
    missing_fields: [],
    source: "ofx",
    raw_text: `${ofx.description} ${ofx.memo || ""}`.trim()
  };
}

export class ImportService {
  private readonly ofxParser = new OfxParser();
  private readonly csvParser = new CsvParser();
  private readonly nubankPdfParser = new NubankPdfParser();
  private readonly picPayPdfParser = new PicPayPdfParser();

  constructor(
    private readonly pendingRepo: PendingRepo,
    private readonly organizzeApi: OrganizzeApiService,
    private readonly categorizer: Categorizer,
    private readonly openRouterImport: OpenRouterImportService
  ) {}

  async createOfxBatch(input: {
    content: string;
    fileName: string;
    chatId: number;
    userId?: number;
  }): Promise<ImportBatch> {
    return this.createBatch({
      ...input,
      transactions: this.ofxParser.parse(input.content).map(toParsed)
    });
  }

  async createCsvBatch(input: {
    content: string;
    fileName: string;
    chatId: number;
    userId?: number;
  }): Promise<ImportBatch> {
    return this.createBatch({
      ...input,
      transactions: this.csvParser.parse(input.content)
    });
  }

  async createPdfBatch(input: {
    buffer: Buffer;
    fileName: string;
    chatId: number;
    userId?: number;
  }): Promise<ImportBatch> {
    const text = await extractPdfText(input.buffer);
    const localTransactions = [
      ...this.nubankPdfParser.parse(text),
      ...this.picPayPdfParser.parse(text)
    ];
    if (localTransactions.length > 0) {
      return this.createBatch({
        ...input,
        transactions: localTransactions
      });
    }

    return this.createBatch({
      ...input,
      transactions: await this.openRouterImport.extractPdf(input.buffer, input.fileName)
    });
  }

  async createImageBatch(input: {
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    chatId: number;
    userId?: number;
  }): Promise<ImportBatch> {
    return this.createBatch({
      ...input,
      transactions: await this.openRouterImport.extractImage(input.buffer, input.mimeType)
    });
  }

  private async createBatch(input: {
    transactions: ParsedTransaction[];
    fileName: string;
    chatId: number;
    userId?: number;
  }): Promise<ImportBatch> {
    const dated = input.transactions.filter((transaction) => transaction.date);
    const start = dated.map((item) => item.date as string).sort()[0];
    const end = dated.map((item) => item.date as string).sort().at(-1);
    const existing = start && end ? await this.organizzeApi.listTransactions({ start_date: start, end_date: end }) : [];

    const candidates: ImportCandidate[] = input.transactions.map((transaction) => {
      const parsed = this.categorizer.enrich(transaction);
      const match = findDuplicate(parsed, existing);

      if (match) {
        return {
          transaction: parsed,
          status: "duplicate",
          reason: "Mesmo valor e data proxima ja existem no Organizze.",
          matched_transaction_id: match.id
        };
      }

      if (parsed.missing_fields.length > 0 || parsed.confidence < 0.85) {
        return {
          transaction: parsed,
          status: "needs_review",
          reason: "Faltam campos ou a categorizacao esta com baixa confianca."
        };
      }

      return {
        transaction: parsed,
        status: "ready"
      };
    });

    return this.pendingRepo.saveImportBatch({
      chat_id: input.chatId,
      user_id: input.userId,
      file_name: input.fileName,
      candidates
    });
  }
}
