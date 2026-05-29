import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { ParsedTransaction, PendingPayload, TransactionBundle } from "../types/finance.js";
import type { OrganizzeTransactionCreatePayload } from "../types/organizze.js";
import type { OrganizzeApiService } from "./organizze-api.js";
import type { PendingRepo } from "../repositories/pending-repo.js";
import type { LearningRepo } from "../repositories/learning-repo.js";
import { formatBRL } from "../utils/money.js";

const FIELD_LABELS: Record<string, string> = {
  description: "descrição",
  amount_cents: "valor",
  date: "data",
  category_id: "categoria",
  account_id_or_credit_card_id: "conta ou cartão"
};

export class ConfirmationService {
  constructor(
    private readonly pendingRepo: PendingRepo,
    private readonly organizzeApi: OrganizzeApiService,
    private readonly confidenceThreshold: number,
    private readonly learningRepo?: LearningRepo
  ) {}

  async ask(ctx: Context, transaction: ParsedTransaction): Promise<void> {
    if (!ctx.chat) return;
    const missing = transaction.missing_fields;
    if (missing.length > 0) {
      const pending = transaction.unresolved_category_name
        ? this.pendingRepo.createPending({
          chat_id: ctx.chat.id,
          user_id: ctx.from?.id,
          payload: transaction
        })
        : undefined;

      await ctx.reply(
        [
          "Preciso de mais dados antes de confirmar.",
          `Faltando: ${missing.map((field) => FIELD_LABELS[field] || field).join(", ")}.`,
          transaction.unresolved_category_name
            ? `Categoria nao encontrada: ${transaction.unresolved_category_name}`
            : "Envie de novo incluindo esses dados, ou cadastre aliases com /alias.",
          transaction.source === "voice" && transaction.raw_text ? `Texto entendido: ${transaction.raw_text.slice(0, 300)}` : ""
        ].join("\n"),
        pending
          ? Markup.inlineKeyboard([
            Markup.button.callback(`Criar categoria ${transaction.unresolved_category_name}`, `catcreate:${pending.id}`)
          ])
          : undefined
      );
      return;
    }

    const pending = this.pendingRepo.createPending({
      chat_id: ctx.chat.id,
      user_id: ctx.from?.id,
      payload: transaction
    });

    const warning = transaction.confidence < this.confidenceThreshold
      ? `\n\nConfiança baixa (${Math.round(transaction.confidence * 100)}%). Confira antes de confirmar.`
      : "";

    await ctx.reply(
      `${this.summary(transaction)}${warning}`,
      Markup.inlineKeyboard([
        Markup.button.callback("Confirmar", `confirm:${pending.id}`),
        Markup.button.callback("Cancelar", `cancel:${pending.id}`)
      ])
    );
  }

  async askBundle(ctx: Context, bundle: TransactionBundle): Promise<void> {
    if (!ctx.chat) return;
    const missing = bundle.transactions.flatMap((transaction, index) => (
      transaction.missing_fields.map((field) => `${index + 1}:${FIELD_LABELS[field] || field}`)
    ));
    if (missing.length > 0) {
      await ctx.reply([
        "Preciso de mais dados antes de confirmar esta operacao.",
        `Faltando: ${missing.join(", ")}.`,
        "Envie de novo incluindo esses dados."
      ].join("\n"));
      return;
    }

    const pending = this.pendingRepo.createPending({
      chat_id: ctx.chat.id,
      user_id: ctx.from?.id,
      payload: bundle
    });

    await ctx.reply(
      this.summaryPayload(bundle),
      Markup.inlineKeyboard([
        Markup.button.callback("Confirmar tudo", `confirm:${pending.id}`),
        Markup.button.callback("Cancelar", `cancel:${pending.id}`)
      ])
    );
  }

  async confirm(ctx: Context, id: string): Promise<void> {
    const pending = this.pendingRepo.getPending(id);
    if (!pending) {
      await ctx.answerCbQuery("Confirmação expirada ou inexistente.");
      return;
    }

    const created = isBundle(pending.payload)
      ? await this.createBundle(pending.payload)
      : [await this.createSingle(pending.payload)];
    this.pendingRepo.deletePending(id);

    await ctx.answerCbQuery("Lançado no Organizze.");
    await ctx.editMessageText([
      created.length === 1 ? "Lancamento criado no Organizze." : "Lancamentos criados no Organizze.",
      `IDs: ${created.map((item) => item.id).join(", ")}`,
      this.summaryPayload(pending.payload)
    ].join("\n"));
  }

  async cancel(ctx: Context, id: string): Promise<void> {
    this.pendingRepo.deletePending(id);
    await ctx.answerCbQuery("Cancelado.");
    await ctx.editMessageText("Lancamento cancelado.");
  }

  summary(transaction: ParsedTransaction): string {
    const target = transaction.credit_card_id
      ? describeEntity("cartao", transaction.credit_card_id, transaction.credit_card_name)
      : describeEntity("conta", transaction.account_id, transaction.account_name);

    const lines = [
      "Confirmar lancamento:",
      `Tipo: ${transaction.type === "expense" ? "despesa" : "receita"}`,
      `Descricao: ${transaction.description}`,
      `Valor: ${formatBRL(transaction.amount_cents)}`,
      `Data: ${transaction.date}`,
      `Status: ${transaction.paid === false ? "a vencer/nao pago" : "pago"}`,
      `Destino: ${target}`,
      `Categoria: ${describeNamedEntity(transaction.category_id, transaction.category_name)}`
    ];

    if (transaction.recurrence) {
      lines.push(`Recorrencia: ${periodicityLabel(transaction.recurrence.periodicity)}`);
    }
    if (transaction.installments) {
      const current = transaction.installments.current ? `${transaction.installments.current}/` : "";
      lines.push(`Parcelamento: ${current}${transaction.installments.total} ${periodicityLabel(transaction.installments.periodicity)}`);
    }
    if (transaction.notes) {
      lines.push(`Notas: ${transaction.notes.slice(0, 180)}`);
    }
    lines.push(`Confiança: ${Math.round(transaction.confidence * 100)}%`);
    return lines.join("\n");
  }

  summaryPayload(payload: PendingPayload): string {
    if (!isBundle(payload)) return this.summary(payload);
    return [
      `Confirmar operacao: ${payload.title}`,
      ...payload.transactions.flatMap((transaction, index) => [
        "",
        `#${index + 1}`,
        this.summary(transaction).replace(/^Confirmar lancamento:\n/, "")
      ]),
      payload.notes ? `\nNotas da operacao: ${payload.notes}` : ""
    ].filter(Boolean).join("\n");
  }

  private async createBundle(bundle: TransactionBundle) {
    const created = [];
    for (const transaction of bundle.transactions) {
      created.push(await this.createSingle(transaction));
    }
    return created;
  }

  private async createSingle(transaction: ParsedTransaction) {
    const created = await this.organizzeApi.createTransaction(this.toOrganizzePayload(transaction));
    this.learningRepo?.learn(transaction);
    return created;
  }

  private toOrganizzePayload(transaction: ParsedTransaction): OrganizzeTransactionCreatePayload {
    if (!transaction.description || transaction.amount_cents === undefined || !transaction.date || !transaction.category_id) {
      throw new Error("Cannot create Organizze payload with missing required fields.");
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
}

function describeEntity(label: string, id?: number, name?: string): string {
  if (!id) return `${label} nao identificado`;
  return name ? `${label} ${name} (#${id})` : `${label} #${id}`;
}

function isBundle(payload: PendingPayload): payload is TransactionBundle {
  return "kind" in payload && payload.kind === "bundle";
}

function describeNamedEntity(id?: number, name?: string): string {
  if (!id) return "nao identificada";
  return name ? `${name} (#${id})` : `#${id}`;
}

function periodicityLabel(periodicity: string): string {
  const labels: Record<string, string> = {
    monthly: "mensal",
    yearly: "anual",
    weekly: "semanal",
    biweekly: "quinzenal",
    bimonthly: "bimestral",
    trimonthly: "trimestral"
  };
  return labels[periodicity] || periodicity;
}
