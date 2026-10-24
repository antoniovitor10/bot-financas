import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../src/config.js";
import { OfxParser } from "../src/parsers/ofx-parser.js";
import { openDatabase } from "../src/repositories/db.js";
import { AliasesRepo } from "../src/repositories/aliases-repo.js";
import { LearningRepo } from "../src/repositories/learning-repo.js";
import { PendingRepo } from "../src/repositories/pending-repo.js";
import { Categorizer } from "../src/services/categorizer.js";
import { OrganizzeApiService } from "../src/services/organizze-api.js";
import type { ImportBatch, ImportCandidate, ParsedTransaction } from "../src/types/finance.js";
import type { OrganizzeCreditCard, OrganizzeTransaction } from "../src/types/organizze.js";

type ExistingTransaction = OrganizzeTransaction & {
  __invoice_id?: number;
  __invoice_date?: string;
};

function normalize(value: string | undefined): string {
  return (value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function tokens(value: string | undefined): Set<string> {
  return new Set(normalize(value).split(/\s+/).filter(Boolean));
}

function textScore(left: string | undefined, right: string | undefined): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function daysBetween(left: string, right: string): number {
  return Math.abs(dayNumber(left) - dayNumber(right));
}

function centsDiff(left: number, right: number): number {
  return Math.abs(left - right);
}

function formatBRL(cents: number | undefined): string {
  if (cents === undefined) return "sem valor";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}

function findNubankCard(cards: OrganizzeCreditCard[]): OrganizzeCreditCard {
  const card = cards.find((item) => {
    const name = normalize(item.name).replace(/\s+/g, "");
    return name.includes("nubank") || name.includes("nubank") || name.includes("nubank") || normalize(item.name) === "nu bank";
  });
  if (!card) throw new Error("Cartao Nubank nao encontrado na API do Organizze.");
  return card;
}

function isPaymentReceived(description: string | undefined): boolean {
  return /\bpagamento\s+recebido\b/i.test(normalize(description));
}

function isSameCard(existing: ExistingTransaction, cardId: number): boolean {
  return existing.credit_card_id === cardId || existing.account_id === cardId || existing.account_type === "CreditCard";
}

function uniqueById(transactions: ExistingTransaction[]): ExistingTransaction[] {
  const seen = new Set<number>();
  return transactions.filter((transaction) => {
    if (seen.has(transaction.id)) return false;
    seen.add(transaction.id);
    return true;
  });
}

function findMatch(transaction: ParsedTransaction, existing: ExistingTransaction[]): ExistingTransaction | undefined {
  if (!transaction.date || transaction.amount_cents === undefined || !transaction.credit_card_id) return undefined;

  return existing
    .filter((item) => isSameCard(item, transaction.credit_card_id as number))
    .map((item) => ({
      item,
      days: daysBetween(item.date, transaction.date as string),
      shiftedForward: item.date >= (transaction.date as string),
      amountDiff: centsDiff(item.amount_cents, transaction.amount_cents as number),
      score: textScore(item.description, transaction.description)
    }))
    .filter((match) => match.amountDiff <= 2)
    .filter((match) => (
      (match.days <= 3 && (match.score >= 0.2 || match.amountDiff === 0)) ||
      (match.shiftedForward && match.days <= 21 && match.score >= 0.2)
    ))
    .sort((left, right) => left.amountDiff - right.amountDiff || left.days - right.days || right.score - left.score)[0]?.item;
}

async function loadExisting(api: OrganizzeApiService, cardId: number, startDate: string, endDate: string): Promise<ExistingTransaction[]> {
  const fromTransactions = await api.listTransactions({ start_date: startDate, end_date: endDate }) as ExistingTransaction[];
  const fromInvoices: ExistingTransaction[] = [];
  const invoices = await api.listCreditCardInvoices(cardId, {
    start_date: startDate,
    end_date: endDate
  });

  for (const invoice of invoices) {
    const detailed = await api.getCreditCardInvoice(cardId, invoice.id);
    for (const transaction of detailed.transactions || []) {
      fromInvoices.push({
        ...transaction,
        __invoice_id: invoice.id,
        __invoice_date: invoice.date
      });
    }
  }

  return uniqueById([...fromTransactions, ...fromInvoices]);
}

function toParsedTransactions(file: string, card: OrganizzeCreditCard): ParsedTransaction[] {
  const content = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return new OfxParser().parse(content).map((transaction) => {
    const payment = isPaymentReceived(transaction.description);
    return {
      type: transaction.amount_cents < 0 ? "expense" : "income",
      description: transaction.description.slice(0, 80),
      amount_cents: transaction.amount_cents,
      date: transaction.date,
      paid: true,
      credit_card_id: card.id,
      credit_card_name: card.name,
      confidence: payment ? 0.5 : 0.9,
      missing_fields: [],
      source: "ofx",
      raw_text: transaction.memo || transaction.description,
      notes: transaction.fit_id ? `OFX Nubank FITID: ${transaction.fit_id}` : "OFX Nubank"
    };
  });
}

function latestChat(db: ReturnType<typeof openDatabase>): { chat_id: number; user_id?: number } {
  const row = db
    .prepare("SELECT chat_id, user_id FROM ofx_import_batches ORDER BY created_at DESC LIMIT 1")
    .get() as { chat_id: number; user_id?: number } | undefined;

  if (row) return row;

  const pendingRow = db
    .prepare("SELECT chat_id, user_id FROM pending_confirmations ORDER BY created_at DESC LIMIT 1")
    .get() as { chat_id: number; user_id?: number } | undefined;

  return pendingRow || { chat_id: 0 };
}

function lineForCandidate(candidate: ImportCandidate, index: number): string {
  const tx = candidate.transaction;
  const match = candidate.matched_transaction_id ? ` -> #${candidate.matched_transaction_id}` : "";
  const reason = candidate.reason ? ` | ${candidate.reason}` : "";
  return `${String(index).padStart(2, "0")}. ${candidate.status.padEnd(12)} ${tx.date} ${formatBRL(tx.amount_cents).padStart(13)} ${tx.description}${match}${reason}`;
}

function batchStats(batch: ImportBatch): string {
  const stats = new Map<string, { count: number; sum: number }>();
  for (const candidate of batch.candidates) {
    const current = stats.get(candidate.status) || { count: 0, sum: 0 };
    current.count += 1;
    current.sum += candidate.transaction.amount_cents || 0;
    stats.set(candidate.status, current);
  }
  return [...stats.entries()]
    .map(([status, stat]) => `${status}: ${stat.count} (${formatBRL(stat.sum)})`)
    .join(" | ");
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error("Uso: npx tsx scripts/audit-nubank-ofx.ts CAMINHO_OFX...");
  }

  const db = openDatabase(config.databasePath);
  const aliases = new AliasesRepo(db);
  const learning = new LearningRepo(db);
  const pending = new PendingRepo(db);
  aliases.migrate();
  learning.migrate();
  pending.migrate();

  const api = new OrganizzeApiService(config.organizze);
  const catalog = await api.getCatalog();
  aliases.syncCatalog(catalog);
  const card = findNubankCard(catalog.creditCards);
  const categorizer = new Categorizer(aliases, { ...config.defaults, creditCardId: card.id }, learning);

  for (const file of files) {
    const parsed = toParsedTransactions(file, card);
    const dates = parsed.map((transaction) => transaction.date).filter((date): date is string => Boolean(date)).sort();
    if (dates.length === 0) {
      console.log(`\n${basename(file)}: sem transacoes com data.`);
      continue;
    }

    const existing = await loadExisting(api, card.id, addDays(dates[0], -45), addDays(dates.at(-1) as string, 45));
    const candidates = parsed.map((transaction): ImportCandidate => {
      const enriched = categorizer.enrich(transaction);
      const payment = isPaymentReceived(enriched.description);
      const match = payment ? undefined : findMatch(enriched, existing);

      if (payment) {
        return {
          transaction: enriched,
          status: "needs_review",
          reason: "Pagamento recebido no cartao; importar so depois de confirmar a conta de origem."
        };
      }

      if (match) {
        return {
          transaction: enriched,
          status: "duplicate",
          reason: `Encontrado na API: ${match.date} ${match.description}${match.__invoice_id ? ` fatura #${match.__invoice_id}` : ""}.`,
          matched_transaction_id: match.id
        };
      }

      if (enriched.missing_fields.length > 0 || enriched.confidence < config.confidenceThreshold) {
        return {
          transaction: enriched,
          status: "needs_review",
          reason: `Campos pendentes: ${enriched.missing_fields.join(", ") || "confianca baixa"}.`
        };
      }

      return {
        transaction: enriched,
        status: "ready"
      };
    });

    const chat = latestChat(db);
    const batch = pending.saveImportBatch({
      chat_id: chat.chat_id,
      user_id: chat.user_id,
      file_name: basename(file),
      candidates
    });

    const expenses = parsed.filter((item) => (item.amount_cents || 0) < 0).reduce((sum, item) => sum + Math.abs(item.amount_cents || 0), 0);
    const credits = parsed.filter((item) => (item.amount_cents || 0) > 0).reduce((sum, item) => sum + (item.amount_cents || 0), 0);
    const net = parsed.reduce((sum, item) => sum + (item.amount_cents || 0), 0);

    console.log(`\nArquivo: ${basename(file)}`);
    console.log(`Lote salvo: ${batch.id}`);
    console.log(`Periodo OFX: ${dates[0]} a ${dates.at(-1)} | itens: ${parsed.length}`);
    console.log(`Despesas: ${formatBRL(expenses)} | Creditos: ${formatBRL(credits)} | Liquido: ${formatBRL(net)}`);
    console.log(batchStats(batch));
    console.log("");
    batch.candidates.forEach((candidate, index) => console.log(lineForCandidate(candidate, index + 1)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
