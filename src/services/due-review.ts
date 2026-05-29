import { Markup } from "telegraf";
import type { OrganizzeCreditCardInvoice, OrganizzeTransaction } from "../types/organizze.js";
import { formatBRL } from "../utils/money.js";

const MAX_BUTTONS = 10;

export type DueItem =
  | { kind: "transaction"; transaction: OrganizzeTransaction }
  | { kind: "invoice"; invoice: OrganizzeCreditCardInvoice; cardName: string };

export function renderDueItems(title: string, items: DueItem[]): string {
  if (items.length === 0) return `${title}\nNenhuma conta a vencer encontrada.`;

  const total = items.reduce((sum, item) => sum + Math.abs(amountForItem(item)), 0);
  return [
    title,
    `Itens: ${items.length} | Total: ${formatBRL(total)}`,
    "",
    ...items.slice(0, MAX_BUTTONS).map((item, index) => lineForItem(item, index + 1)),
    items.length > MAX_BUTTONS ? `\nMostrando ${MAX_BUTTONS} de ${items.length}. Use um periodo menor para ver menos itens.` : ""
  ].filter(Boolean).join("\n");
}

export function dueKeyboard(items: DueItem[]) {
  const payable = items.filter((item) => item.kind === "transaction").slice(0, MAX_BUTTONS);
  return Markup.inlineKeyboard(
    payable.map((item, index) => [
      Markup.button.callback(`Marcar pago ${index + 1}`, `pay:${item.transaction.id}`)
    ])
  );
}

function amountForItem(item: DueItem): number {
  return item.kind === "transaction"
    ? item.transaction.amount_cents
    : item.invoice.balance_cents || item.invoice.amount_cents;
}

function lineForItem(item: DueItem, index: number): string {
  if (item.kind === "invoice") {
    return `${index}. fatura ${item.cardName} | vence ${item.invoice.date} | ${formatBRL(amountForItem(item))}`;
  }

  const transaction = item.transaction;
  return [
    `${index}. #${transaction.id} ${transaction.date} ${formatBRL(transaction.amount_cents)}`,
    transaction.description,
    `conta #${transaction.account_id}`
  ].join(" | ");
}
