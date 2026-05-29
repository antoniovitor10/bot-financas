import type { ParsedTransaction } from "../types/finance.js";
import { parseDatePt, todayIso } from "../utils/dates.js";
import { parseAmountToCents, signedAmount } from "../utils/money.js";

type CsvRow = Record<string, string>;

const HEADER_ALIASES = {
  date: ["data", "date", "dt", "lancamento", "lançamento"],
  description: ["descricao", "descrição", "description", "historico", "histórico", "memo", "titulo", "título", "estabelecimento"],
  amount: ["valor", "amount", "total", "value", "vlr"],
  debit: ["debito", "débito", "debit", "saida", "saída"],
  credit: ["credito", "crédito", "credit", "entrada"],
  category: ["categoria", "category"],
  account: ["conta", "account"],
  card: ["cartao", "cartão", "card", "credit_card"]
} as const;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function detectDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ";" : ",";
}

function parseRows(content: string): CsvRow[] {
  const delimiter = detectDelimiter(content);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter).map(normalize);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line, delimiter);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function valueByAlias(row: CsvRow, aliases: readonly string[]): string | undefined {
  const keys = Object.keys(row);
  for (const alias of aliases.map(normalize)) {
    const exact = keys.find((key) => key === alias);
    if (exact && row[exact]) return row[exact];
    const partial = keys.find((key) => key.includes(alias) || alias.includes(key));
    if (partial && row[partial]) return row[partial];
  }
  return undefined;
}

function amountFromRow(row: CsvRow): number | undefined {
  const amount = valueByAlias(row, HEADER_ALIASES.amount);
  if (amount) return parseAmountToCents(amount);

  const debit = valueByAlias(row, HEADER_ALIASES.debit);
  if (debit) {
    const cents = parseAmountToCents(debit);
    return cents === undefined ? undefined : -Math.abs(cents);
  }

  const credit = valueByAlias(row, HEADER_ALIASES.credit);
  if (credit) {
    const cents = parseAmountToCents(credit);
    return cents === undefined ? undefined : Math.abs(cents);
  }

  return undefined;
}

function missingFields(transaction: ParsedTransaction): string[] {
  const missing: string[] = [];
  if (!transaction.description) missing.push("description");
  if (transaction.amount_cents === undefined) missing.push("amount_cents");
  if (!transaction.date) missing.push("date");
  return missing;
}

export class CsvParser {
  parse(content: string): ParsedTransaction[] {
    return parseRows(content)
      .map((row): ParsedTransaction => {
        const rawAmount = amountFromRow(row);
        const type = rawAmount !== undefined && rawAmount > 0 ? "income" : "expense";
        const amount = rawAmount === undefined ? undefined : rawAmount < 0 ? rawAmount : signedAmount(type, rawAmount);
        const description = valueByAlias(row, HEADER_ALIASES.description)?.trim();
        const dateText = valueByAlias(row, HEADER_ALIASES.date);
        const category = valueByAlias(row, HEADER_ALIASES.category);
        const account = valueByAlias(row, HEADER_ALIASES.account);
        const card = valueByAlias(row, HEADER_ALIASES.card);
        const rawText = Object.values(row).filter(Boolean).join(" ");
        const transaction: ParsedTransaction = {
          type,
          description,
          amount_cents: amount,
          date: dateText ? parseDatePt(dateText) : todayIso(),
          notes: `CSV: ${rawText}`.slice(0, 500),
          confidence: 0.8,
          missing_fields: [],
          source: "csv",
          raw_text: [rawText, category, account, card].filter(Boolean).join(" ")
        };

        transaction.missing_fields = missingFields(transaction);
        if (transaction.missing_fields.length === 0) transaction.confidence = 0.88;
        return transaction;
      })
      .filter((transaction) => transaction.description || transaction.amount_cents !== undefined);
  }
}
