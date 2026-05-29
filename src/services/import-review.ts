import { Markup } from "telegraf";
import type { ImportBatch, ImportCandidate, ImportCandidateStatus } from "../types/finance.js";
import { formatBRL } from "../utils/money.js";

export type BatchViewStatus = "all" | ImportCandidateStatus;

const PAGE_SIZE = 12;

const STATUS_LABELS: Record<BatchViewStatus, string> = {
  all: "todos",
  ready: "prontos",
  duplicate: "duplicados",
  needs_review: "revisar",
  imported: "importados"
};

const CALLBACK_STATUS: Record<BatchViewStatus, string> = {
  all: "a",
  ready: "r",
  duplicate: "d",
  needs_review: "n",
  imported: "i"
};

const STATUS_BY_CALLBACK: Record<string, BatchViewStatus> = {
  a: "all",
  r: "ready",
  d: "duplicate",
  n: "needs_review",
  i: "imported"
};

export function statusFromCallback(value: string): BatchViewStatus {
  return STATUS_BY_CALLBACK[value] || "all";
}

export function renderBatchSummary(batch: ImportBatch, label: string): string {
  const stats = batchStats(batch);
  const reviewPreview = batch.candidates
    .filter((item) => item.status === "needs_review")
    .slice(0, 5);
  const readyPreview = batch.candidates
    .filter((item) => item.status === "ready")
    .slice(0, Math.max(0, 8 - reviewPreview.length));
  const preview = [...reviewPreview, ...readyPreview];

  return [
    `${label} importado para revisao: ${batch.id}`,
    `Total: ${stats.all.count} | prontos: ${stats.ready.count} | importados: ${stats.imported.count} | duplicados: ${stats.duplicate.count} | revisar: ${stats.needs_review.count}`,
    `Despesas: ${formatBRL(stats.all.expenses)} | Creditos/estornos: ${formatBRL(stats.all.credits)} | Liquido: ${formatBRL(stats.all.sum)}`,
    `Prontos: ${formatBRL(stats.ready.sum)} | Revisar: ${formatBRL(stats.needs_review.sum)} | Duplicados: ${formatBRL(stats.duplicate.sum)}`,
    "",
    "Itens de revisao aparecem primeiro. Compare a soma extraida com o total da fatura.",
    "",
    ...preview.map((item, index) => lineForCandidate(item, index + 1))
  ].join("\n");
}

export function renderBatchPage(batch: ImportBatch, status: BatchViewStatus, page: number): string {
  const items = filteredCandidates(batch, status);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  const sum = items.reduce((total, item) => total + (item.transaction.amount_cents || 0), 0);
  const expenses = items
    .filter((item) => (item.transaction.amount_cents || 0) < 0)
    .reduce((total, item) => total + Math.abs(item.transaction.amount_cents || 0), 0);
  const credits = items
    .filter((item) => (item.transaction.amount_cents || 0) > 0)
    .reduce((total, item) => total + (item.transaction.amount_cents || 0), 0);

  return [
    `Lote ${batch.id} - ${STATUS_LABELS[status]}`,
    `Pagina ${currentPage + 1}/${pageCount} | Itens: ${items.length}`,
    `Despesas: ${formatBRL(expenses)} | Creditos/estornos: ${formatBRL(credits)} | Liquido: ${formatBRL(sum)}`,
    "",
    ...pageItems.map((item, index) => lineForCandidate(item, start + index + 1, true))
  ].join("\n");
}

export function batchSummaryKeyboard(batch: ImportBatch) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Revisar (${batchStats(batch).needs_review.count})`, batchCallback(batch.id, "needs_review", 0)),
      Markup.button.callback(`Prontos (${batchStats(batch).ready.count})`, batchCallback(batch.id, "ready", 0))
    ],
    [
      Markup.button.callback("Todos", batchCallback(batch.id, "all", 0)),
      Markup.button.callback(`Duplicados (${batchStats(batch).duplicate.count})`, batchCallback(batch.id, "duplicate", 0))
    ],
    [
      Markup.button.callback(`Confirmar prontos (${batchStats(batch).ready.count})`, `batchconfirm:${batch.id}`)
    ]
  ]);
}

export function batchPageKeyboard(batch: ImportBatch, status: BatchViewStatus, page: number) {
  const items = filteredCandidates(batch, status);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const buttons = [];

  if (currentPage > 0) {
    buttons.push(Markup.button.callback("Anterior", batchCallback(batch.id, status, currentPage - 1)));
  }
  if (currentPage < pageCount - 1) {
    buttons.push(Markup.button.callback("Proxima", batchCallback(batch.id, status, currentPage + 1)));
  }

  return Markup.inlineKeyboard([
    buttons,
    [
      Markup.button.callback("Resumo", batchCallback(batch.id, "all", -1)),
      Markup.button.callback("Revisar", batchCallback(batch.id, "needs_review", 0)),
      Markup.button.callback("Prontos", batchCallback(batch.id, "ready", 0))
    ],
    [
      Markup.button.callback(`Confirmar prontos (${batchStats(batch).ready.count})`, `batchconfirm:${batch.id}`)
    ]
  ].filter((row) => row.length > 0));
}

export function batchCallback(id: string, status: BatchViewStatus, page: number): string {
  return `batch:${id}:${CALLBACK_STATUS[status]}:${page}`;
}

function batchStats(batch: ImportBatch): Record<BatchViewStatus, { count: number; sum: number; expenses: number; credits: number }> {
  const initial = {
    all: { count: 0, sum: 0, expenses: 0, credits: 0 },
    ready: { count: 0, sum: 0, expenses: 0, credits: 0 },
    duplicate: { count: 0, sum: 0, expenses: 0, credits: 0 },
    needs_review: { count: 0, sum: 0, expenses: 0, credits: 0 },
    imported: { count: 0, sum: 0, expenses: 0, credits: 0 }
  };

  for (const item of batch.candidates) {
    const amount = item.transaction.amount_cents || 0;
    initial.all.count += 1;
    initial.all.sum += amount;
    if (amount < 0) initial.all.expenses += Math.abs(amount);
    if (amount > 0) initial.all.credits += amount;
    initial[item.status].count += 1;
    initial[item.status].sum += amount;
    if (amount < 0) initial[item.status].expenses += Math.abs(amount);
    if (amount > 0) initial[item.status].credits += amount;
  }

  return initial;
}

function filteredCandidates(batch: ImportBatch, status: BatchViewStatus): ImportCandidate[] {
  if (status === "all") return [...batch.candidates].sort((left, right) => statusPriority(left.status) - statusPriority(right.status));
  return batch.candidates.filter((item) => item.status === status);
}

function statusPriority(status: ImportCandidateStatus): number {
  if (status === "needs_review") return 0;
  if (status === "ready") return 1;
  if (status === "imported") return 2;
  return 3;
}

function lineForCandidate(item: ImportCandidate, index: number, includeReason = false): string {
  const tx = item.transaction;
  const target = tx.credit_card_name || tx.account_name || tx.credit_card_id || tx.account_id || "sem conta/cartao";
  const category = tx.category_name || tx.category_id || "sem categoria";
  const installment = tx.installments ? ` | parcela ${tx.installments.current ? `${tx.installments.current}/` : ""}${tx.installments.total}` : "";
  const reason = includeReason && item.reason ? ` | ${item.reason}` : "";
  return `${index}. ${item.status}: ${tx.date || "sem data"} ${formatBRL(tx.amount_cents)} ${tx.description || "sem descricao"} | ${target} | ${category}${installment}${reason}`;
}
