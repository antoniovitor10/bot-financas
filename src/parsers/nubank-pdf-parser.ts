import type { ParsedTransaction } from "../types/finance.js";
import { parseAmountToCents } from "../utils/money.js";

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEV: 2,
  MAR: 3,
  ABR: 4,
  MAI: 5,
  JUN: 6,
  JUL: 7,
  AGO: 8,
  SET: 9,
  OUT: 10,
  NOV: 11,
  DEZ: 12
};

interface PeriodInfo {
  dueDate?: string;
  dueYear?: number;
  startMonth?: number;
  endMonth?: number;
}

export class NubankPdfParser {
  parse(text: string): ParsedTransaction[] {
    if (!this.canParse(text)) return [];

    const period = parsePeriodInfo(text);
    const transactions = parseTransactionLines(text, period);
    const otherCharges = parseSummaryAmount(text, "Outros lançamentos");
    const totalDue = parseSummaryAmount(text, "Total a pagar");
    const detailedNet = Math.abs(transactions.reduce((sum, transaction) => sum + (transaction.amount_cents || 0), 0));
    const missingFromDetails = totalDue ? totalDue - detailedNet : 0;

    if (otherCharges && missingFromDetails > 100) {
      transactions.push({
        type: "expense",
        description: "Outros lançamentos da fatura Nubank",
        amount_cents: -Math.min(otherCharges, Math.round(missingFromDetails)),
        date: period.dueDate,
        notes: "Valor agregado informado no resumo da fatura. Revise antes de importar.",
        confidence: 0.65,
        missing_fields: [],
        source: "pdf",
        raw_text: "outros lancamentos nu bank outros"
      });
    }

    return transactions;
  }

  private canParse(text: string): boolean {
    return /FATURA\s+\d{2}\s+[A-Z]{3}\s+\d{4}/i.test(text) &&
      /TRANSAÇÕES DE|TRANSACOES DE/i.test(text) &&
      /Nu Pagamentos|Nubank/i.test(text);
  }
}

function parseTransactionLines(text: string, period: PeriodInfo): ParsedTransaction[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const transactions: ParsedTransaction[] = [];
  let inTransactions = false;
  let currentDate: string | undefined;

  for (const line of lines) {
    if (/^TRANSAÇÕES DE|^TRANSACOES DE/i.test(line)) {
      inTransactions = true;
      continue;
    }

    if (!inTransactions) continue;
    if (/^Pagamentos\b/i.test(line)) break;

    const inlineDateMatch = line.match(/^(\d{2})\s+([A-Z]{3})\s+(.+)$/i);
    const dateMatch = line.match(/^(\d{2})\s+([A-Z]{3})$/i);

    let transactionLine = line;
    if (inlineDateMatch) {
      currentDate = toIsoDate(Number(inlineDateMatch[1]), inlineDateMatch[2].toUpperCase(), period);
      transactionLine = inlineDateMatch[3].trim();
    }

    if (dateMatch) {
      currentDate = toIsoDate(Number(dateMatch[1]), dateMatch[2].toUpperCase(), period);
      continue;
    }

    if (!currentDate || !transactionLine.includes("R$") || /^Antonio\b/i.test(transactionLine)) continue;

    const amountMatch = transactionLine.match(/([−-]?\s*R\$\s*[\d.]+,\d{2})$/);
    if (!amountMatch) continue;

    const amountText = amountMatch[1];
    const cents = parseAmountToCents(amountText);
    if (cents === undefined) continue;

    const rawDescription = transactionLine.slice(0, amountMatch.index).trim();
    if (/^Pagamento\b/i.test(rawDescription)) continue;

    const last4 = rawDescription.match(/^[•\s]*(\d{4})\s+/)?.[1];
    const description = rawDescription
      .replace(/^[•\s]+/, "")
      .replace(/^\d{4}\s+/, "")
      .trim();
    if (!description) continue;

    const isCredit = /[−-]/.test(amountText) || /^Estorno\b/i.test(description);
    const categoryHint = inferCategoryHint(description);
    const installments = description.match(/Parcela\s+(\d+)\/(\d+)/i);

    transactions.push({
      type: isCredit ? "income" : "expense",
      description,
      amount_cents: isCredit ? Math.abs(cents) : -Math.abs(cents),
      date: currentDate,
      installments: installments ? { current: Number(installments[1]), total: Number(installments[2]), periodicity: "monthly" } : undefined,
      notes: [
        "Fatura Nubank",
        last4 ? `final do cartao ${last4}` : undefined,
        installments ? `parcela ${installments[1]}/${installments[2]}` : undefined
      ].filter(Boolean).join("; "),
      confidence: 0.9,
      missing_fields: [],
      source: "pdf",
      raw_text: [description, "nu bank", categoryHint].join(" ")
    });
  }

  return transactions;
}

function parsePeriodInfo(text: string): PeriodInfo {
  const due = text.match(/Data de vencimento:\s*(\d{2})\s+([A-Z]{3})\s+(\d{4})/i);
  const period = text.match(/Período vigente:\s*\d{2}\s+([A-Z]{3})\s+a\s+\d{2}\s+([A-Z]{3})/i);
  const dueYear = due ? Number(due[3]) : new Date().getFullYear();
  const dueDate = due ? toIsoDate(Number(due[1]), due[2].toUpperCase(), { dueYear }) : undefined;

  return {
    dueDate,
    dueYear,
    startMonth: period ? MONTHS[period[1].toUpperCase()] : undefined,
    endMonth: period ? MONTHS[period[2].toUpperCase()] : undefined
  };
}

function parseSummaryAmount(text: string, label: string): number | undefined {
  const pattern = new RegExp(`${escapeRegExp(label)}\\s+R\\$\\s*([\\d.]+,\\d{2})`, "i");
  const match = text.match(pattern);
  return match ? Math.abs(parseAmountToCents(match[1]) || 0) : undefined;
}

function toIsoDate(day: number, monthText: string, period: PeriodInfo): string | undefined {
  const month = MONTHS[monthText];
  if (!month) return undefined;
  let year = period.dueYear || new Date().getFullYear();

  if (period.startMonth && period.endMonth && period.startMonth > period.endMonth && month >= period.startMonth) {
    year -= 1;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function inferCategoryHint(description: string): string {
  const normalized = description
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  if (/\b(uber|99app|99 app|uber\*|uber rides|trip|dl\*uber|dl \*uber)\b/.test(normalized)) return "transporte";
  if (/\b(ifood|estacao doce|flor d|sabores|lanche|restaurante)\b/.test(normalized)) return "alimentacao";
  if (/\b(farmacia|dental|clinica|odonto)\b/.test(normalized)) return "saude";
  if (/\b(vivo|conta vivo)\b/.test(normalized)) return "casa";
  if (/\b(apple|bill|assinatura)\b/.test(normalized)) return "assinaturas e servicos";
  if (/^estorno\b/.test(normalized)) return "outros";
  return "compras";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
