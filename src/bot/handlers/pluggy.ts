import type { Telegraf, Telegram } from "telegraf";
import type { AliasesRepo } from "../../repositories/aliases-repo.js";
import type { PluggyRepo } from "../../repositories/pluggy-repo.js";
import type { PluggySyncResult, PluggySyncService } from "../../services/pluggy-sync.js";
import type { AliasKind } from "../../types/finance.js";
import type { PluggyMapKind } from "../../types/pluggy.js";
import { batchSummaryKeyboard, renderBatchSummary } from "../../services/import-review.js";
import { formatBRL } from "../../utils/money.js";
import { logger } from "../../utils/logger.js";

interface PluggyHandlerDeps {
  pluggySync?: PluggySyncService;
  pluggyRepo: PluggyRepo;
  aliasesRepo: AliasesRepo;
}

const HELP = [
  "Comandos da Pluggy:",
  "/pluggy  busca transacoes novas e monta um lote para revisao",
  "/pluggy contas  lista contas e cartoes da Pluggy e para onde vao",
  "/pluggy mapear PREFIXO conta ID_OU_NOME  liga uma conta Pluggy a uma conta do backend",
  "/pluggy mapear PREFIXO cartao ID_OU_NOME  liga a um cartao",
  "/pluggy mapear PREFIXO ignorar  deixa de ler essa conta",
  "/pluggy status  resumo do que ja foi lido",
  "PREFIXO sao os primeiros caracteres do id mostrado em /pluggy contas."
].join("\n");

const NOT_CONFIGURED = "Pluggy nao configurada. Defina PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEMS no .env.";

export function registerPluggyHandlers(bot: Telegraf, deps: PluggyHandlerDeps): void {
  bot.command("pluggy", async (ctx) => {
    const args = ctx.message.text.replace(/^\/pluggy(@\w+)?\s*/i, "").trim();
    const [sub = "", ...rest] = args.split(/\s+/).filter(Boolean);

    if (!deps.pluggySync) {
      await ctx.reply(NOT_CONFIGURED);
      return;
    }

    try {
      if (sub === "" || sub === "sync" || sub === "sincronizar") {
        await ctx.reply("Buscando transacoes na Pluggy...");
        const result = await deps.pluggySync.sync({ chatId: ctx.chat.id, userId: ctx.from?.id });
        await sendSyncResult(ctx.telegram, ctx.chat.id, result, { quiet: false });
        return;
      }

      if (sub === "contas") {
        const { accounts, errors } = await deps.pluggySync.refreshAccounts();
        const lines = accounts.map(({ account, itemName, map }) => {
          const kind = account.type === "CREDIT" ? "cartao" : account.subtype === "SAVINGS_ACCOUNT" ? "poupanca" : "conta";
          const destination = !map
            ? "SEM MAPEAMENTO"
            : map.kind === "ignore"
              ? "ignorada"
              : `${map.kind === "credit_card" ? "cartao" : "conta"} ${map.target_name} (#${map.target_id})${map.auto ? " auto" : ""}`;
          return `${account.id.slice(0, 8)}  ${itemName} ${kind} "${account.name}" ${formatBRL(Math.round((account.balance || 0) * 100))}  ->  ${destination}`;
        });
        await ctx.reply([
          `Contas na Pluggy (${accounts.length}). Data de corte: ${deps.pluggySync.startDate}.`,
          ...lines,
          errors.length ? `Erros: ${errors.map((error) => `${error.scope}: ${error.message}`).join("; ")}` : "",
          "",
          "Para mapear: /pluggy mapear PREFIXO conta|cartao ID_OU_NOME, ou /pluggy mapear PREFIXO ignorar."
        ].filter((line) => line !== undefined).join("\n"));
        return;
      }

      if (sub === "mapear") {
        await ctx.reply(mapAccount(deps, rest));
        return;
      }

      if (sub === "status") {
        const counts = deps.pluggyRepo.countByStatus();
        const states = deps.pluggyRepo.listSyncStates();
        const lastSync = states.map((state) => state.last_synced_at).sort().at(-1);
        const withError = states.filter((state) => state.last_error);
        await ctx.reply([
          `Pluggy: ${deps.pluggySync.items.map((item) => item.name).join(", ")}.`,
          `Data de corte: ${deps.pluggySync.startDate}.`,
          `Ultima sincronizacao: ${lastSync ? lastSync.replace("T", " ").slice(0, 16) : "nunca"}.`,
          `Transacoes: em lote ${counts.batched || 0} | importadas ${counts.imported || 0} | adiadas (futuras) ${counts.deferred || 0} | antes do corte ${counts.ignored || 0} | descartadas ${counts.skipped || 0}.`,
          withError.length ? `Contas com erro: ${withError.map((state) => `${state.account_id.slice(0, 8)}: ${state.last_error}`).join("; ")}` : ""
        ].filter(Boolean).join("\n"));
        return;
      }

      await ctx.reply(HELP);
    } catch (error) {
      logger.error("Pluggy command failed", { error: (error as Error).message });
      await ctx.reply(`Erro na Pluggy: ${(error as Error).message}`);
    }
  });
}

function mapAccount(deps: PluggyHandlerDeps, args: string[]): string {
  const [prefix, kindWord, ...nameParts] = args;
  if (!prefix || !kindWord) {
    return "Formato: /pluggy mapear PREFIXO conta|cartao ID_OU_NOME, ou /pluggy mapear PREFIXO ignorar.";
  }

  const account = deps.pluggyRepo.findAccountByPrefix(prefix);
  if (!account) {
    return `Nao achei conta Pluggy com prefixo "${prefix}". Rode /pluggy contas e use os primeiros caracteres do id.`;
  }

  const kind = KIND_WORDS[kindWord.toLowerCase()];
  if (!kind) {
    return `Tipo "${kindWord}" invalido. Use conta, cartao ou ignorar.`;
  }

  if (kind === "ignore") {
    deps.pluggyRepo.setMap({ pluggyAccountId: account.id, kind: "ignore" });
    return `Conta ${account.item_name} "${account.name}" sera ignorada.`;
  }

  const query = nameParts.join(" ").trim();
  if (!query) {
    return "Informe o ID ou o nome da conta/cartao do backend.";
  }

  const aliasKind: AliasKind = kind;
  const target = /^\d+$/.test(query)
    ? deps.aliasesRepo.findCatalogById(aliasKind, Number(query))
    : deps.aliasesRepo.findAlias(aliasKind, query) || deps.aliasesRepo.findMention(aliasKind, query);
  if (!target) {
    return `Nao achei ${kind === "credit_card" ? "cartao" : "conta"} "${query}" no catalogo. Rode /sync e confira em /aliases.`;
  }

  deps.pluggyRepo.setMap({ pluggyAccountId: account.id, kind, targetId: target.id, targetName: target.name });
  return `Mapeado: ${account.item_name} "${account.name}" -> ${kind === "credit_card" ? "cartao" : "conta"} ${target.name} (#${target.id}).`;
}

const KIND_WORDS: Record<string, PluggyMapKind> = {
  conta: "account",
  account: "account",
  cartao: "credit_card",
  "cartão": "credit_card",
  card: "credit_card",
  ignorar: "ignore",
  ignore: "ignore"
};

export function renderSyncResult(result: PluggySyncResult): string {
  const lines = [
    `Pluggy: ${result.accounts} contas lidas | novas: ${result.candidates} | futuras adiadas: ${result.deferred} | antes do corte: ${result.ignored} | descartadas: ${result.skipped} | ja conhecidas: ${result.alreadyKnown + result.alreadyImported}`
  ];
  if (result.unmapped.length) {
    lines.push(
      "Contas sem mapeamento (nao lidas):",
      ...result.unmapped.map((account) => (
        `  ${account.id.slice(0, 8)}  ${account.itemName} ${account.type === "CREDIT" ? "cartao" : account.subtype === "SAVINGS_ACCOUNT" ? "poupanca" : "conta"} "${account.name}"`
      )),
      "Use /pluggy mapear PREFIXO conta|cartao ID_OU_NOME ou /pluggy mapear PREFIXO ignorar."
    );
  }
  if (result.errors.length) {
    lines.push("Erros:", ...result.errors.map((error) => `  ${error.scope}: ${error.message}`));
  }
  if (!result.batch && result.candidates === 0) {
    lines.push("Nada novo para revisar.");
  }
  return lines.join("\n");
}

/**
 * Envia o resultado de um sync para um chat. Em modo `quiet` (agendado) so
 * manda mensagem quando ha lote novo, conta sem mapeamento ou erro.
 */
export async function sendSyncResult(
  telegram: Telegram,
  chatId: number,
  result: PluggySyncResult,
  options: { quiet: boolean }
): Promise<void> {
  const worthSending = !!result.batch || result.unmapped.length > 0 || result.errors.length > 0;
  if (options.quiet && !worthSending) return;

  await telegram.sendMessage(chatId, renderSyncResult(result));
  if (result.batch) {
    await telegram.sendMessage(chatId, renderBatchSummary(result.batch, "Pluggy"), batchSummaryKeyboard(result.batch));
  }
}
