import type { Telegraf } from "telegraf";
import type { ConfirmationService } from "../../services/confirmation.js";
import type { PendingRepo } from "../../repositories/pending-repo.js";
import type { AliasesRepo } from "../../repositories/aliases-repo.js";
import type { LearningRepo } from "../../repositories/learning-repo.js";
import type { Categorizer } from "../../services/categorizer.js";
import type { OrganizzeApiService } from "../../services/organizze-api.js";
import type { ParsedTransaction } from "../../types/finance.js";
import type { OrganizzeTransactionCreatePayload } from "../../types/organizze.js";
import { formatBRL } from "../../utils/money.js";
import {
  batchPageKeyboard,
  batchSummaryKeyboard,
  renderBatchPage,
  renderBatchSummary,
  statusFromCallback
} from "../../services/import-review.js";
import { logger } from "../../utils/logger.js";

interface CallbackDeps {
  confirmation: ConfirmationService;
  pendingRepo: PendingRepo;
  organizzeApi: OrganizzeApiService;
  aliasesRepo: AliasesRepo;
  learningRepo: LearningRepo;
  categorizer: Categorizer;
  syncCatalog: () => Promise<void>;
}

export function registerCallbackHandlers(bot: Telegraf, deps: CallbackDeps): void {
  bot.action(/^confirm:(.+)$/, async (ctx) => {
    try {
      await deps.confirmation.confirm(ctx, ctx.match[1]);
    } catch (error) {
      logger.error("Failed to confirm transaction", { error: (error as Error).message });
      await ctx.answerCbQuery("Erro ao criar lançamento.");
      await ctx.reply(`Erro ao criar lançamento: ${(error as Error).message}`);
    }
  });

  bot.action(/^cancel:(.+)$/, async (ctx) => {
    await deps.confirmation.cancel(ctx, ctx.match[1]);
  });

  bot.action(/^pay:(\d+)$/, async (ctx) => {
    try {
      const transaction = await deps.organizzeApi.updateTransaction(Number(ctx.match[1]), { paid: true });
      await ctx.answerCbQuery("Marcado como pago.");
      await ctx.reply(`Marcado como pago: #${transaction.id} ${transaction.description}`);
    } catch (error) {
      logger.error("Failed to mark transaction paid", { error: (error as Error).message });
      await ctx.answerCbQuery("Erro ao marcar como pago.");
      await ctx.reply(`Erro ao marcar como pago: ${(error as Error).message}`);
    }
  });

  bot.action(/^catcreate:(.+)$/, async (ctx) => {
    try {
      const pending = deps.pendingRepo.getPending(ctx.match[1]);
      if (!pending || "kind" in pending.payload) {
        await ctx.answerCbQuery("Confirmacao nao encontrada.");
        return;
      }

      const payload = pending.payload as ParsedTransaction;
      const name = payload.unresolved_category_name;
      if (!name) {
        await ctx.answerCbQuery("Sem categoria para criar.");
        return;
      }

      const category = await deps.organizzeApi.createCategory({ name });
      deps.aliasesRepo.upsertAlias("category", name, category.id, category.name);
      await deps.syncCatalog();
      const enriched = deps.categorizer.enrich({
        ...payload,
        category_id: category.id,
        category_name: category.name,
        unresolved_category_name: undefined
      });
      deps.pendingRepo.deletePending(pending.id);
      await ctx.answerCbQuery("Categoria criada.");
      await deps.confirmation.ask(ctx, enriched);
    } catch (error) {
      logger.error("Failed to create category", { error: (error as Error).message });
      await ctx.answerCbQuery("Erro ao criar categoria.");
      await ctx.reply(`Erro ao criar categoria: ${(error as Error).message}`);
    }
  });

  bot.action(/^batchconfirm:(.+)$/, async (ctx) => {
    try {
      const batch = deps.pendingRepo.getImportBatch(ctx.match[1]);
      if (!batch) {
        await ctx.answerCbQuery("Lote nao encontrado.");
        return;
      }

      const ready = batch.candidates.filter((candidate) => candidate.status === "ready");
      if (ready.length === 0) {
        await ctx.answerCbQuery("Nao ha itens prontos.");
        return;
      }

      await ctx.answerCbQuery(`Importando ${ready.length} itens...`);
      let createdCount = 0;
      for (const candidate of ready) {
        const created = await deps.organizzeApi.createTransaction(toOrganizzePayload(candidate.transaction));
        candidate.status = "imported";
        candidate.reason = `Importado no Organizze: #${created.id}`;
        candidate.matched_transaction_id = created.id;
        deps.learningRepo.learn(candidate.transaction);
        createdCount += 1;
      }

      deps.pendingRepo.updateImportBatch(batch);
      await ctx.editMessageText(renderBatchSummary(batch, "Lote"), batchSummaryKeyboard(batch));
      await ctx.reply(`Importacao concluida: ${createdCount} itens prontos criados no Organizze.`);
    } catch (error) {
      logger.error("Failed to confirm import batch", { error: (error as Error).message });
      await ctx.answerCbQuery("Erro ao importar lote.");
      await ctx.reply(`Erro ao importar lote: ${(error as Error).message}`);
    }
  });

  bot.action(/^batch:([^:]+):([^:]+):(-?\d+)$/, async (ctx) => {
    const [, batchId, statusCode, pageText] = ctx.match;
    const batch = deps.pendingRepo.getImportBatch(batchId);
    if (!batch) {
      await ctx.answerCbQuery("Lote nao encontrado.");
      return;
    }

    const status = statusFromCallback(statusCode);
    const page = Number(pageText);
    await ctx.answerCbQuery();

    if (page < 0) {
      await ctx.editMessageText(renderBatchSummary(batch, "Lote"), batchSummaryKeyboard(batch));
      return;
    }

    await ctx.editMessageText(renderBatchPage(batch, status, page), batchPageKeyboard(batch, status, page));
  });

  bot.action(/^invoice:(\d+):(\d+):(\d+)$/, async (ctx) => {
    try {
      const [, cardIdText, invoiceIdText, pageText] = ctx.match;
      const cardId = Number(cardIdText);
      const invoiceId = Number(invoiceIdText);
      const page = Number(pageText);
      const invoice = await deps.organizzeApi.getCreditCardInvoice(cardId, invoiceId);
      await ctx.answerCbQuery();
      await ctx.editMessageText(renderInvoiceTransactions(invoice, page), invoiceKeyboard(cardId, invoiceId, invoice.transactions?.length || 0, page));
    } catch (error) {
      logger.error("Failed to render invoice transactions", { error: (error as Error).message });
      await ctx.answerCbQuery("Erro ao carregar transacoes.");
      await ctx.reply(`Erro ao carregar transacoes da fatura: ${(error as Error).message}`);
    }
  });
}

const INVOICE_PAGE_SIZE = 10;

function renderInvoiceTransactions(invoice: { id: number; transactions?: ParsedTransactionLike[] }, page: number): string {
  const transactions = invoice.transactions || [];
  if (transactions.length === 0) return `Fatura #${invoice.id}\nNenhuma transacao retornada pela API.`;

  const pageCount = Math.max(1, Math.ceil(transactions.length / INVOICE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * INVOICE_PAGE_SIZE;
  const items = transactions.slice(start, start + INVOICE_PAGE_SIZE);

  return [
    `Fatura #${invoice.id} - transacoes`,
    `Pagina ${currentPage + 1}/${pageCount} | Itens: ${transactions.length}`,
    "",
    ...items.map((transaction, index) => `${start + index + 1}. ${transaction.date} ${formatBRL(transaction.amount_cents)} ${transaction.description}`)
  ].join("\n");
}

function invoiceKeyboard(cardId: number, invoiceId: number, count: number, page: number) {
  const pageCount = Math.max(1, Math.ceil(count / INVOICE_PAGE_SIZE));
  const buttons = [];
  if (page > 0) buttons.push({ text: "Anterior", callback_data: `invoice:${cardId}:${invoiceId}:${page - 1}` });
  if (page < pageCount - 1) buttons.push({ text: "Proxima", callback_data: `invoice:${cardId}:${invoiceId}:${page + 1}` });
  return { reply_markup: { inline_keyboard: buttons.length ? [buttons] : [] } };
}

interface ParsedTransactionLike {
  date: string;
  amount_cents: number;
  description: string;
}

function toOrganizzePayload(transaction: ParsedTransaction): OrganizzeTransactionCreatePayload {
  if (!transaction.description || transaction.amount_cents === undefined || !transaction.date || !transaction.category_id) {
    throw new Error("Nao consigo importar item pronto com campos obrigatorios faltando.");
  }

  return {
    description: transaction.description,
    amount_cents: transaction.amount_cents,
    date: transaction.date,
    paid: transaction.paid ?? true,
    account_id: transaction.account_id,
    credit_card_id: transaction.credit_card_id,
    category_id: transaction.category_id,
    notes: transaction.notes,
    recurrence_attributes: transaction.recurrence,
    installments_attributes: transaction.installments
      ? { periodicity: transaction.installments.periodicity, total: transaction.installments.total }
      : undefined
  };
}
