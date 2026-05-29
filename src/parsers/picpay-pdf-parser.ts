import type { ParsedTransaction } from "../types/finance.js";
import { parseAmountToCents } from "../utils/money.js";

interface PicPayPeriod {
  dueYear: number;
  closingMonth: number;
}

export class PicPayPdfParser {
  parse(text: string): ParsedTransaction[] {
    if (!this.canParse(text)) return [];

    const period = parsePeriod(text);
    const transactions = parseTransactions(text, period);
    return transactions;
  }

  private canParse(text: string): boolean {
    return /PicPay Mastercard/i.test(text) &&
      /Total geral dos lan[çc]amentos/i.test(text) &&
      /Transa[çc][õo]es Nacionais/i.test(text);
  }
}

function parseTransactions(text: string, period: PicPayPeriod): ParsedTransaction[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const transactions: ParsedTransaction[] = [];
  let currentCardFinal: string | undefined;
  let inTransactions = false;

  for (const line of lines) {
    const cardMatch = line.match(/Picpay Card final\s+(\d{4})/i);
    if (cardMatch) {
      currentCardFinal = cardMatch[1];
      inTransactions = false;
      continue;
    }

    if (/^Transa[çc][õo]es Nacionais/i.test(line)) {
      inTransactions = true;
      continue;
    }

    if (currentCardFinal && /^Valores em R\$|^Encargos/i.test(line)) break;
    if (!inTransactions || !currentCardFinal) continue;
    if (/^(Data Estabelecimento|Subtotal|Total geral|P[aá]gina|--)/i.test(line)) continue;

    const match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+([+-]?[\d.]+,\d{2})$/);
    if (!match) continue;

    const description = match[3].trim();
    if (/PAGAMENTO DE FATURA/i.test(description)) continue;

    const amount = parseAmountToCents(match[4]);
    if (amount === undefined) continue;

    const installment = parseInstallment(description);
    const cleanDescription = cleanupDescription(description);
    const categoryHint = inferCategoryHint(cleanDescription);

    transactions.push({
      type: "expense",
      description: cleanDescription,
      amount_cents: -Math.abs(amount),
      date: toTransactionDate(Number(match[1]), Number(match[2]), period),
      paid: true,
      installments: installment ? { current: installment.current, total: installment.total, periodicity: "monthly" } : undefined,
      notes: [
        "Fatura PicPay",
        `final do cartao ${currentCardFinal}`,
        installment ? `parcela ${installment.current}/${installment.total}` : undefined
      ].filter(Boolean).join("; "),
      confidence: 0.9,
      missing_fields: [],
      source: "pdf",
      raw_text: [cleanDescription, "picpay", categoryHint].join(" ")
    });
  }

  return transactions;
}

function parsePeriod(text: string): PicPayPeriod {
  const due = text.match(/Vencimento\s+(\d{2})\/(\d{2})\/(20\d{2})/i) || text.match(/(\d{2})-(\d{2})-(20\d{2})\s*\|\s*(\d{2})-(\d{2})-(20\d{2})/);
  const headerDates = text.match(/(\d{2})-(\d{2})-(20\d{2})\s*\|\s*(\d{2})-(\d{2})-(20\d{2})/);
  const closing = text.match(/Fechamento:\s*(?:\n|.){0,30}?(\d{2})\s+de\s+([A-Za-zçÇ]+)/i);
  const dueYear = due ? Number(due[3]) : new Date().getFullYear();
  return {
    dueYear,
    closingMonth: headerDates
      ? Number(headerDates[5])
      : closing
        ? monthNumber(closing[2]) || Number(due?.[2] || new Date().getMonth() + 1)
        : Number(due?.[2] || new Date().getMonth() + 1)
  };
}

function toTransactionDate(day: number, month: number, period: PicPayPeriod): string {
  const year = month > period.closingMonth ? period.dueYear - 1 : period.dueYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseInstallment(description: string): { current: number; total: number } | undefined {
  const match = description.match(/PARC\s*(\d{1,2})\/(\d{1,2})/i);
  if (!match) return undefined;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return total > 1 ? { current, total } : undefined;
}

function cleanupDescription(description: string): string {
  return description
    .replace(/\s*[-*]?\s*\d?PARC\s*\d{1,2}\/\d{1,2}/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function inferCategoryHint(description: string): string {
  const normalized = description.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/\b(hostgator|google cloud|claude|anthropic|netflix|subscription)\b/.test(normalized)) return "assinaturas e servicos";
  if (/\b(dom burguer|burger|coffee|ifd|acaiteria|mercadinho|merkado|queijo|sorvetes|brasa)\b/.test(normalized)) return "alimentacao";
  if (/\b(rota transport|viacao|aguia branca|uber)\b/.test(normalized)) return "transporte";
  if (/\b(farmacia|pague menos|odontomaster)\b/.test(normalized)) return "saude";
  if (/\b(vivara|anacapri|riachuelo|santa lolla|havan)\b/.test(normalized)) return "compras";
  return "compras";
}

function monthNumber(name: string): number | undefined {
  const normalized = name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return {
    janeiro: 1,
    fevereiro: 2,
    marco: 3,
    abril: 4,
    maio: 5,
    junho: 6,
    julho: 7,
    agosto: 8,
    setembro: 9,
    outubro: 10,
    novembro: 11,
    dezembro: 12
  }[normalized];
}
