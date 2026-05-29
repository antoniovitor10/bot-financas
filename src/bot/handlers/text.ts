import { Markup } from "telegraf";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { AliasesRepo } from "../../repositories/aliases-repo.js";
import type { LearningRepo, LearnedTransactionPattern } from "../../repositories/learning-repo.js";
import type { PendingRepo } from "../../repositories/pending-repo.js";
import type { Categorizer } from "../../services/categorizer.js";
import type { ConfirmationService } from "../../services/confirmation.js";
import type { OrganizzeApiService } from "../../services/organizze-api.js";
import type { TextParser } from "../../parsers/text-parser.js";
import type { LoanParser } from "../../parsers/loan-parser.js";
import type { AliasKind } from "../../types/finance.js";
import { batchSummaryKeyboard, renderBatchSummary } from "../../services/import-review.js";
import { dueKeyboard, renderDueItems, type DueItem } from "../../services/due-review.js";
import { logger } from "../../utils/logger.js";
import { addDaysIso, currentMonthRange, todayIso } from "../../utils/dates.js";
import { parseAmountToCents, formatBRL } from "../../utils/money.js";

interface TextHandlerDeps {
  textParser: TextParser;
  loanParser: LoanParser;
  categorizer: Categorizer;
  confirmation: ConfirmationService;
  aliasesRepo: AliasesRepo;
  learningRepo: LearningRepo;
  pendingRepo: PendingRepo;
  organizzeApi: OrganizzeApiService;
  syncCatalog: () => Promise<void>;
}

const KIND_MAP: Record<string, AliasKind> = {
  conta: "account",
  account: "account",
  categoria: "category",
  category: "category",
  cartao: "credit_card",
  cartão: "credit_card",
  card: "credit_card"
};

export function registerTextHandlers(bot: Telegraf, deps: TextHandlerDeps): void {
  bot.start(async (ctx) => {
    await ctx.reply([
      "Envie um lançamento em texto ou voz.",
      "Ex.: gastei 42,90 no mercado hoje no nubank categoria mercado",
      "Use /alias categoria mercado=123 para cadastrar apelidos locais."
    ].join("\n"));
  });

  bot.command("sync", async (ctx) => {
    try {
      await deps.syncCatalog();
      await ctx.reply("Catalogo do Organizze atualizado.");
    } catch (error) {
      logger.error("Manual catalog sync failed", { error: (error as Error).message });
      await ctx.reply(`Erro ao sincronizar catalogo: ${(error as Error).message}`);
    }
  });

  bot.command("aliases", async (ctx) => {
    const aliases = deps.aliasesRepo.listAliases();
    if (aliases.length === 0) {
      await ctx.reply("Nenhum alias cadastrado.");
      return;
    }
    const lines = aliases.slice(0, 80).map((alias) => `${alias.kind}: ${alias.alias} -> #${alias.target_id} ${alias.target_name}`);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("aprendizados", async (ctx) => {
    const learned = deps.learningRepo.list(30);
    if (learned.length === 0) {
      await ctx.reply("Nenhum padrao aprendido ainda. O bot aprende depois que voce confirma, importa ou edita lancamentos.");
      return;
    }

    await ctx.reply([
      "Padroes aprendidos:",
      ...learned.map(renderLearnedPattern),
      "",
      "Para apagar um padrao: /esquecer nome_do_padrao"
    ].join("\n"));
  });

  bot.command("esquecer", async (ctx) => {
    const input = ctx.message.text.replace(/^\/esquecer(@\w+)?\s*/i, "").trim();
    if (!input) {
      await ctx.reply("Formato: /esquecer nome_do_padrao");
      return;
    }

    const removed = deps.learningRepo.forget(input);
    await ctx.reply(removed
      ? `Padrao esquecido: ${deps.learningRepo.normalizePattern(input)}`
      : `Nao encontrei esse padrao: ${deps.learningRepo.normalizePattern(input) || input}`);
  });

  bot.command("lote", async (ctx) => {
    const id = ctx.message.text.replace(/^\/lote(@\w+)?\s*/i, "").trim();
    if (!id) {
      await ctx.reply("Formato: /lote ID_DO_LOTE");
      return;
    }

    const batch = deps.pendingRepo.getImportBatch(id);
    if (!batch) {
      await ctx.reply("Lote nao encontrado.");
      return;
    }

    await ctx.reply(renderBatchSummary(batch, "Lote"), batchSummaryKeyboard(batch));
  });

  bot.command("editar_lote", async (ctx) => {
    const input = ctx.message.text.replace(/^\/editar_lote(@\w+)?\s*/i, "").trim();
    const match = input.match(/^(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      await ctx.reply('Formato: /editar_lote ID_LOTE NUMERO nome="Novo nome" categoria=Mercado');
      return;
    }

    const batch = deps.pendingRepo.getImportBatch(match[1]);
    if (!batch) {
      await ctx.reply("Lote nao encontrado.");
      return;
    }

    const index = Number(match[2]) - 1;
    const candidate = batch.candidates[index];
    if (!candidate) {
      await ctx.reply("Item nao encontrado nesse lote.");
      return;
    }

    const values = parseKeyValues(match[3]);
    applyTransactionEdits(candidate.transaction, values, deps);
    deps.learningRepo.learn(candidate.transaction);
    candidate.status = candidate.transaction.missing_fields.length > 0 || candidate.transaction.confidence < 0.85 ? "needs_review" : "ready";
    candidate.reason = "Editado manualmente no bot.";
    deps.pendingRepo.updateImportBatch(batch);
    await ctx.reply([
      `Item ${index + 1} atualizado no lote ${batch.id}.`,
      renderBatchSummary(batch, "Lote")
    ].join("\n\n"), batchSummaryKeyboard(batch));
  });

  bot.command("editar", async (ctx) => {
    const input = ctx.message.text.replace(/^\/editar(@\w+)?\s*/i, "").trim();
    const match = input.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      await ctx.reply('Formato: /editar ID nome="Novo nome" categoria=Mercado');
      return;
    }

    const values = parseKeyValues(match[2]);
    const category = values.categoria || values.category
      ? deps.aliasesRepo.findMention("category", values.categoria || values.category)
      : undefined;
    const updated = await deps.organizzeApi.updateTransaction(Number(match[1]), {
      description: values.nome || values.name || values.descricao || values.description,
      category_id: category?.id,
      notes: values.notas || values.notes
    });
    deps.learningRepo.learn({
      type: updated.amount_cents < 0 ? "expense" : "income",
      description: updated.description,
      amount_cents: updated.amount_cents,
      date: updated.date,
      paid: updated.paid,
      account_id: updated.credit_card_id ? undefined : updated.account_id,
      credit_card_id: updated.credit_card_id ?? undefined,
      category_id: updated.category_id,
      account_name: updated.credit_card_id ? undefined : deps.aliasesRepo.findCatalogById("account", updated.account_id)?.name,
      credit_card_name: updated.credit_card_id ? deps.aliasesRepo.findCatalogById("credit_card", updated.credit_card_id)?.name : undefined,
      category_name: deps.aliasesRepo.findCatalogById("category", updated.category_id)?.name,
      notes: updated.notes || undefined,
      confidence: 0.95,
      missing_fields: [],
      source: "text",
      raw_text: match[2]
    });
    await ctx.reply(`Lancamento atualizado: #${updated.id} ${updated.description}`);
  });

  bot.command("vencer", async (ctx) => {
    await replyDue(ctx, deps, "Contas a vencer nos proximos 7 dias", todayIso(), addDaysIso(todayIso(), 7));
  });

  bot.command("semana", async (ctx) => {
    await replyDue(ctx, deps, "Contas da semana", todayIso(), addDaysIso(todayIso(), 7));
  });

  bot.command("mes", async (ctx) => {
    const range = currentMonthRange();
    await replyDue(ctx, deps, "Contas do mes", range.start, range.end);
  });

  bot.command("pagar", async (ctx) => {
    const id = Number(ctx.message.text.replace(/^\/pagar(@\w+)?\s*/i, "").trim());
    if (!Number.isFinite(id)) {
      await ctx.reply("Formato: /pagar ID_DO_LANCAMENTO");
      return;
    }
    const transaction = await deps.organizzeApi.updateTransaction(id, { paid: true });
    await ctx.reply(`Marcado como pago: #${transaction.id} ${transaction.description}`);
  });

  bot.command("faturas", async (ctx) => {
    const cards = deps.aliasesRepo.getCatalog("credit_card");
    await ctx.reply(cards.length
      ? ["Cartoes disponiveis:", ...cards.map((card) => `#${card.id} ${card.name}`), "", "Use /fatura nome_do_cartao"].join("\n")
      : "Nenhum cartao encontrado. Rode /sync primeiro.");
  });

  bot.command("fatura", async (ctx) => {
    const query = ctx.message.text.replace(/^\/fatura(@\w+)?\s*/i, "").trim();
    if (!query) {
      await ctx.reply("Formato: /fatura picpay");
      return;
    }
    const card = deps.aliasesRepo.findMention("credit_card", query);
    if (!card) {
      await ctx.reply("Cartao nao encontrado por alias. Use /faturas para ver os nomes.");
      return;
    }
    const invoices = await deps.organizzeApi.listCreditCardInvoices(card.id, {
      start_date: addDaysIso(todayIso(), -60),
      end_date: addDaysIso(todayIso(), 90)
    });
    const selected = invoices
      .sort((left, right) => left.date.localeCompare(right.date))
      .find((invoice) => invoice.date >= todayIso()) || invoices.at(-1);
    if (!selected) {
      await ctx.reply(`Nenhuma fatura encontrada para ${card.name}.`);
      return;
    }
    const invoice = await deps.organizzeApi.getCreditCardInvoice(card.id, selected.id);
    await ctx.reply([
      `Fatura ${card.name} (#${card.id})`,
      `ID: ${invoice.id}`,
      `Vencimento: ${invoice.date}`,
      `Periodo: ${invoice.starting_date} a ${invoice.closing_date}`,
      `Valor: ${formatBRL(invoice.amount_cents)}`,
      `Pago: ${formatBRL(invoice.payment_amount_cents)}`,
      `Saldo: ${formatBRL(invoice.balance_cents)}`,
      `Transacoes: ${invoice.transactions?.length || 0}`
    ].join("\n"), Markup.inlineKeyboard([
      Markup.button.callback("Ver transacoes", `invoice:${card.id}:${invoice.id}:0`)
    ]));
  });

  bot.command("editar_conta", async (ctx) => {
    const input = ctx.message.text.replace(/^\/editar_conta(@\w+)?\s*/i, "").trim();
    const { id, values } = parseEditCommand(input);
    if (!id || Object.keys(values).length === 0) {
      await ctx.reply("Formato: /editar_conta ID nome=Novo Nome tipo=checking descricao=Texto");
      return;
    }
    const account = await deps.organizzeApi.updateAccount(id, {
      name: values.nome || values.name,
      type: values.tipo || values.type,
      description: values.descricao || values.description
    });
    await deps.syncCatalog();
    await ctx.reply(`Conta atualizada: #${account.id} ${account.name}`);
  });

  bot.command("editar_cartao", async (ctx) => {
    const input = ctx.message.text.replace(/^\/editar_cartao(@\w+)?\s*/i, "").trim();
    const { id, values } = parseEditCommand(input);
    if (!id || Object.keys(values).length === 0) {
      await ctx.reply("Formato: /editar_cartao ID nome=PicPay vencimento=5 fechamento=29 limite=6700 bandeira=mastercard");
      return;
    }
    const card = await deps.organizzeApi.updateCreditCard(id, {
      name: values.nome || values.name,
      card_network: values.bandeira || values.card_network,
      due_day: toNumber(values.vencimento || values.due_day),
      closing_day: toNumber(values.fechamento || values.closing_day),
      limit_cents: values.limite ? Math.abs(parseAmountToCents(values.limite) || 0) : undefined,
      description: values.descricao || values.description
    });
    await deps.syncCatalog();
    await ctx.reply(`Cartao atualizado: #${card.id} ${card.name}`);
  });

  bot.command("ajustar", async (ctx) => {
    const input = ctx.message.text.replace(/^\/ajustar(@\w+)?\s*/i, "").trim();
    const match = input.match(/^conta\s+(.+?)\s+para\s+(.+?)(?:\s+categoria\s+(.+))?$/i);
    if (!match) {
      await ctx.reply("Formato: /ajustar conta caixa para 1000 categoria ajuste");
      return;
    }
    const account = deps.aliasesRepo.findMention("account", match[1]);
    const category = match[3] ? deps.aliasesRepo.findMention("category", match[3]) : deps.aliasesRepo.findMention("category", "outros");
    const target = parseAmountToCents(match[2]);
    if (!account || target === undefined || !category) {
      await ctx.reply("Nao encontrei conta, valor ou categoria para o ajuste.");
      return;
    }
    const remote = (await deps.organizzeApi.getAccounts()).find((item) => item.id === account.id);
    if (remote?.balance_cents === undefined) {
      await ctx.reply("A API nao retornou saldo atual dessa conta para calcular o ajuste.");
      return;
    }
    const delta = target - remote.balance_cents;
    if (delta === 0) {
      await ctx.reply("A conta ja esta com esse saldo.");
      return;
    }
    await deps.confirmation.ask(ctx, deps.categorizer.enrich({
      type: delta > 0 ? "income" : "expense",
      description: `Ajuste de saldo ${account.name}`,
      amount_cents: delta,
      date: todayIso(),
      paid: true,
      account_id: account.id,
      account_name: account.name,
      category_id: category.id,
      category_name: category.name,
      notes: `Ajuste para saldo ${formatBRL(target)}. Saldo anterior ${formatBRL(remote.balance_cents)}.`,
      confidence: 0.95,
      missing_fields: [],
      source: "text",
      raw_text: input
    }));
  });

  bot.command("cancelar", async (ctx) => {
    if (!ctx.chat) return;
    const deleted = deps.pendingRepo.deleteByChat(ctx.chat.id);
    await ctx.reply(`Confirmações removidas: ${deleted}.`);
  });

  bot.command("alias", async (ctx) => {
    const text = ctx.message.text.replace(/^\/alias(@\w+)?\s*/i, "").trim();
    const match = text.match(/^(\S+)\s+(.+?)\s*=\s*(\d+)$/);
    if (!match) {
      await ctx.reply("Formato: /alias conta apelido=123 | /alias categoria mercado=456 | /alias cartao nubank=789");
      return;
    }

    const kind = KIND_MAP[match[1].toLowerCase()];
    if (!kind) {
      await ctx.reply("Tipo invalido. Use conta, categoria ou cartao.");
      return;
    }

    const id = Number(match[3]);
    const target = deps.aliasesRepo.getCatalog(kind).find((item) => item.id === id);
    deps.aliasesRepo.upsertAlias(kind, match[2], id, target?.name || `#${id}`);
    await ctx.reply(`Alias salvo: ${kind} "${match[2]}" -> #${id}${target ? ` ${target.name}` : ""}`);
  });

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    try {
      const loan = deps.loanParser.parse(text, "text");
      if (loan) {
        const bundle = {
          ...loan,
          transactions: loan.transactions.map((transaction) => deps.categorizer.enrich(transaction))
        };
        await deps.confirmation.askBundle(ctx, bundle);
        return;
      }

      const parsed = deps.textParser.parse(text);
      const enriched = deps.categorizer.enrich(parsed);
      await deps.confirmation.ask(ctx, enriched);
    } catch (error) {
      logger.error("Text handler failed", { error: (error as Error).message });
      await ctx.reply(`Não consegui interpretar essa mensagem: ${(error as Error).message}`);
    }
  });
}

async function replyDue(ctx: Context, deps: TextHandlerDeps, title: string, start: string, end: string): Promise<void> {
  const transactions = await deps.organizzeApi.listTransactions({ start_date: start, end_date: end });
  const accountTransactions = transactions
    .filter((transaction) => !transaction.paid && !transaction.credit_card_id && transaction.date >= start && transaction.date <= end)
    .map((transaction): DueItem => ({ kind: "transaction", transaction }));
  const invoiceItems = await listDueInvoices(deps, start, end);
  const items = [...accountTransactions, ...invoiceItems].sort((left, right) => dateForDueItem(left).localeCompare(dateForDueItem(right)));
  await ctx.reply(renderDueItems(title, items), dueKeyboard(items));
}

async function listDueInvoices(deps: TextHandlerDeps, start: string, end: string): Promise<DueItem[]> {
  const items: DueItem[] = [];
  for (const card of deps.aliasesRepo.getCatalog("credit_card")) {
    try {
      const invoices = await deps.organizzeApi.listCreditCardInvoices(card.id, {
        start_date: addDaysIso(start, -45),
        end_date: addDaysIso(end, 45)
      });
      for (const invoice of invoices) {
        const balance = invoice.balance_cents || invoice.amount_cents;
        if (invoice.date >= start && invoice.date <= end && balance > 0) {
          items.push({ kind: "invoice", invoice, cardName: card.name });
        }
      }
    } catch (error) {
      logger.error("Failed to list credit card invoices for due view", { cardId: card.id, error: (error as Error).message });
    }
  }
  return items;
}

function dateForDueItem(item: DueItem): string {
  return item.kind === "transaction" ? item.transaction.date : item.invoice.date;
}

function renderLearnedPattern(pattern: LearnedTransactionPattern): string {
  const targets = [
    pattern.category_id ? `categoria ${pattern.category_name || `#${pattern.category_id}`}` : "",
    pattern.credit_card_id ? `cartao ${pattern.credit_card_name || `#${pattern.credit_card_id}`}` : "",
    pattern.account_id ? `conta ${pattern.account_name || `#${pattern.account_id}`}` : ""
  ].filter(Boolean);
  return [
    `- ${pattern.pattern}`,
    targets.length ? ` -> ${targets.join(" | ")}` : "",
    ` (${pattern.seen_count}x, ${Math.round(pattern.confidence * 100)}%)`
  ].join("");
}

function parseEditCommand(input: string): { id?: number; values: Record<string, string> } {
  const idMatch = input.match(/^(\d+)\s*/);
  const values: Record<string, string> = {};
  if (!idMatch) return { values };

  Object.assign(values, parseKeyValues(input.slice(idMatch[0].length)));

  return { id: Number(idMatch[1]), values };
}

function parseKeyValues(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of input.matchAll(/(\w+)=("[^"]+"|\S+)/g)) {
    values[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
  }
  return values;
}

function applyTransactionEdits(transaction: { description?: string; category_id?: number; category_name?: string; notes?: string; confidence: number; missing_fields: string[] }, values: Record<string, string>, deps: TextHandlerDeps): void {
  const name = values.nome || values.name || values.descricao || values.description;
  if (name) transaction.description = name;

  const categoryName = values.categoria || values.category;
  if (categoryName) {
    const category = deps.aliasesRepo.findMention("category", categoryName);
    if (category) {
      transaction.category_id = category.id;
      transaction.category_name = category.name;
    }
  }

  if (values.notas || values.notes) transaction.notes = values.notas || values.notes;
  transaction.confidence = Math.max(transaction.confidence, 0.95);
  transaction.missing_fields = [
    !transaction.description ? "description" : "",
    !transaction.category_id ? "category_id" : ""
  ].filter(Boolean);
}

function toNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
