import type { ParsedTransaction, TransactionBundle, TransactionSource } from "../types/finance.js";
import { parseDatePt, todayIso, addDaysIso } from "../utils/dates.js";
import { extractAmountCents } from "./amount-parser.js";

const LOAN_OUT_HINT = /\b(emprestei|emprestar|emprestado|emprestada)\b/i;
const RECEIVABLE_DATE_HINT = /\b(?:receber|recebo|receber de volta|devolver|devolve|me paga|me pagar|pagar de volta|volta)\b(.{0,60})/i;

export class LoanParser {
  parse(text: string, source: TransactionSource = "text"): TransactionBundle | undefined {
    if (!LOAN_OUT_HINT.test(text)) return undefined;

    const amount = extractAmountCents(text);
    if (amount === undefined) return undefined;

    const loanDate = parseDatePt(text.replace(RECEIVABLE_DATE_HINT, "")) || todayIso();
    const receivableDate = parseReceivableDate(text) || addDaysIso(loanDate, 30);
    const borrower = extractBorrower(text);
    const description = borrower ? `Emprestimo para ${borrower}` : "Emprestimo realizado";
    const confidence = parseReceivableDate(text) ? 0.88 : 0.72;

    const outgoing: ParsedTransaction = {
      type: "expense",
      description,
      amount_cents: -Math.abs(amount),
      date: loanDate,
      paid: true,
      notes: `Saida de emprestimo. Texto original: ${text}`,
      confidence,
      missing_fields: [],
      source,
      raw_text: `${text} emprestimos`
    };

    const receivable: ParsedTransaction = {
      type: "income",
      description: borrower ? `Receber emprestimo de ${borrower}` : "Receber emprestimo",
      amount_cents: Math.abs(amount),
      date: receivableDate,
      paid: false,
      notes: parseReceivableDate(text)
        ? `Conta a receber criada a partir do emprestimo. Texto original: ${text}`
        : `Conta a receber criada com vencimento sugerido em 30 dias. Texto original: ${text}`,
      confidence,
      missing_fields: [],
      source,
      raw_text: `${text} emprestimos`
    };

    return {
      kind: "bundle",
      title: "Emprestimo com conta a receber",
      transactions: [outgoing, receivable],
      notes: "Confirme apenas se a saida e o recebivel estiverem corretos.",
      source,
      raw_text: text
    };
  }
}

function parseReceivableDate(text: string): string | undefined {
  const match = text.match(RECEIVABLE_DATE_HINT);
  return match ? parseDatePt(match[1]) : undefined;
}

function extractBorrower(text: string): string | undefined {
  const match = text.match(/\b(?:para|pra|pro|a|ao|emprestei para|emprestei pra)\s+([^,.;]+?)(?:\s+(?:usando|na|no|pela|pelo|categoria|receber|devolver|me paga|me pagar|dia|hoje|ontem|amanh[aã])\b|$)/i);
  const borrower = match?.[1]
    ?.replace(/\b(minha|meu|um|uma|o|a)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return borrower || undefined;
}
