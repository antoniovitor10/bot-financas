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
      const match = parsed.date
        ? existing.find((existingTransaction) => (
          existingTransaction.amount_cents === parsed.amount_cents &&
          dateDistanceDays(existingTransaction.date, parsed.date as string) <= 3
        ))
        : undefined;

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
