import { config } from "../src/config.js";
import { openDatabase } from "../src/repositories/db.js";
import { OrganizzeApiService } from "../src/services/organizze-api.js";

type Candidate = {
  status: string;
  matched_transaction_id?: number;
  transaction: {
    description?: string;
    amount_cents?: number;
    date?: string;
    credit_card_id?: number;
    credit_card_name?: string;
    category_name?: string;
  };
};

type ExistingTransaction = {
  id: number;
  description: string;
  date: string;
  amount_cents: number;
  category_id?: number;
  account_id?: number;
  account_type?: string;
  credit_card_id?: number | null;
};

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

function formatMoney(cents: number | undefined): string {
  if (cents === undefined) return "sem valor";
  const sign = cents < 0 ? "-" : "";
  return `${sign}R$ ${(Math.abs(cents) / 100).toFixed(2).replace(".", ",")}`;
}

function normalize(value: string | undefined): string {
  return (value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function textScore(left: string | undefined, right: string | undefined): number {
  const leftTokens = new Set(normalize(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalize(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function uniqueById(transactions: ExistingTransaction[]): ExistingTransaction[] {
  const seen = new Set<number>();
  return transactions.filter((transaction) => {
    if (seen.has(transaction.id)) return false;
    seen.add(transaction.id);
    return true;
  });
}

async function loadExistingTransactions(
  api: OrganizzeApiService,
  startDate: string,
  endDate: string,
  creditCardId?: number
): Promise<ExistingTransaction[]> {
  const fromTransactions = await api.listTransactions({ start_date: startDate, end_date: endDate });
  const fromInvoices: ExistingTransaction[] = [];

  if (creditCardId) {
    try {
      const invoices = await api.listCreditCardInvoices(creditCardId, {
        start_date: startDate,
        end_date: endDate
      });

      for (const invoice of invoices) {
        try {
          const detailed = await api.getCreditCardInvoice(creditCardId, invoice.id);
          if (detailed.transactions) fromInvoices.push(...detailed.transactions);
        } catch (error) {
          console.warn(`Nao consegui detalhar fatura ${invoice.id}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      console.warn(`Nao consegui consultar faturas do cartao ${creditCardId}: ${(error as Error).message}`);
    }
  }

  return uniqueById([...fromTransactions, ...fromInvoices]);
}

async function main(): Promise<void> {
  const batchId = process.argv[2];
  const windowDays = Number(process.argv[3] || 45);
  const db = openDatabase(config.databasePath);

  const row = batchId
    ? db.prepare("SELECT * FROM ofx_import_batches WHERE id = ?").get(batchId)
    : db.prepare("SELECT * FROM ofx_import_batches WHERE lower(file_name) LIKE '%nubank%' ORDER BY created_at DESC LIMIT 1").get();

  if (!row) {
    throw new Error(batchId ? `Lote nao encontrado: ${batchId}` : "Nenhum lote Nubank encontrado");
  }

  const batch = row as { id: string; file_name: string; created_at: string; candidates_json: string };
  const candidates = JSON.parse(batch.candidates_json) as Candidate[];
  const ready = candidates.filter((candidate) => candidate.status === "ready");
  const dated = ready
    .map((candidate) => candidate.transaction.date)
    .filter((date): date is string => Boolean(date))
    .sort();

  if (dated.length === 0) {
    throw new Error(`Lote ${batch.id} nao tem itens ready com data`);
  }

  const creditCardId = ready.find((candidate) => candidate.transaction.credit_card_id)?.transaction.credit_card_id;
  const startDate = addDays(dated[0], -windowDays);
  const endDate = addDays(dated.at(-1) as string, windowDays);
  const api = new OrganizzeApiService(config.organizze);
  const existing = await loadExistingTransactions(api, startDate, endDate, creditCardId);

  const audited = ready.map((candidate) => {
    const transaction = candidate.transaction;
    const sameAmount = existing
      .filter((existingTransaction) => existingTransaction.amount_cents === transaction.amount_cents)
      .map((existingTransaction) => ({
        ...existingTransaction,
        days: transaction.date ? daysBetween(existingTransaction.date, transaction.date) : 999,
        score: textScore(existingTransaction.description, transaction.description)
      }))
      .sort((left, right) => left.days - right.days || right.score - left.score);

    const near = sameAmount.filter((existingTransaction) => existingTransaction.days <= 7);
    const shiftedInvoiceDate = sameAmount.filter((existingTransaction) => existingTransaction.days <= 21 && existingTransaction.score >= 0.2);
    const likely = near.length > 0 || shiftedInvoiceDate.length > 0 || sameAmount.length === 1;
    const status = near.length > 0
      ? "provavel_match_data_proxima"
      : shiftedInvoiceDate.length > 0
        ? "provavel_match_data_fatura"
        : sameAmount.length === 1
          ? "possivel_match_valor_unico"
          : "sem_match";

    return {
      candidate,
      likely,
      status,
      near,
      shiftedInvoiceDate,
      sameAmount: sameAmount.slice(0, 5)
    };
  });

  const likely = audited.filter((item) => item.likely);
  const noMatch = audited.filter((item) => !item.likely);

  console.log(`Lote: ${batch.id} | ${batch.file_name} | criado em ${batch.created_at}`);
  console.log(`Consulta API: ${startDate} a ${endDate} | cartao: ${creditCardId ?? "nao identificado"} | transacoes encontradas: ${existing.length}`);
  console.log(`Ready no lote: ${ready.length} | Provavelmente ja existem: ${likely.length} | Sem match por valor: ${noMatch.length}`);
  console.log("");

  for (const [index, item] of audited.entries()) {
    const transaction = item.candidate.transaction;
    console.log(`${index + 1}. ${item.status}: ${transaction.date} ${formatMoney(transaction.amount_cents)} ${transaction.description || "sem descricao"} | ${transaction.credit_card_name || "sem cartao"} | ${transaction.category_name || "sem categoria"}`);

    const matches = item.near.length > 0 ? item.near : item.shiftedInvoiceDate.length > 0 ? item.shiftedInvoiceDate : item.sameAmount;
    for (const match of matches.slice(0, 3)) {
      const distance = match.days === 0 ? "mesma data" : `${match.days}d`;
      console.log(`   -> #${match.id} ${match.date} ${formatMoney(match.amount_cents)} ${match.description} | ${distance} | score ${match.score.toFixed(2)} | card ${match.credit_card_id ?? "-"} | account ${match.account_id ?? "-"}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
