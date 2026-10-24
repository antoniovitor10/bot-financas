import type { ImportBatch, ImportCandidate, ParsedTransaction } from "../types/finance.js";
import type { PluggyAccount, PluggyAccountMap, PluggyItemConfig, PluggyTransaction } from "../types/pluggy.js";
import type { PluggyApiService } from "./pluggy-api.js";
import type { PluggyRepo } from "../repositories/pluggy-repo.js";
import type { AliasesRepo } from "../repositories/aliases-repo.js";
import type { PendingRepo } from "../repositories/pending-repo.js";
import type { Categorizer } from "./categorizer.js";
import type { OrganizzeApiService } from "./organizze-api.js";
import { findDuplicate } from "./duplicates.js";
import { signedAmount } from "../utils/money.js";
import { addDaysIso, todayIso } from "../utils/dates.js";
import { logger } from "../utils/logger.js";

/**
 * Categoria da Pluggy (ingles) -> palavras em portugues que o Categorizer e os
 * aliases de categoria do backend reconhecem. Nao colocar nome de banco aqui:
 * o texto tambem passa pela deteccao de conta/cartao.
 */
const PLUGGY_CATEGORY_HINTS: Record<string, string> = {
  "groceries": "mercado supermercado",
  "supermarket": "mercado supermercado",
  "food and drinks": "alimentacao restaurante",
  "eating out": "alimentacao restaurante",
  "restaurants": "alimentacao restaurante",
  "delivery": "alimentacao ifood",
  "food delivery": "alimentacao ifood",
  "bars and nightlife": "alimentacao lazer",
  "coffee shops": "alimentacao lanche",
  "transportation": "transporte",
  "taxi and ride-hailing": "transporte uber",
  "public transportation": "transporte onibus",
  "gas stations": "transporte posto gasolina",
  "parking": "transporte estacionamento",
  "tolls": "transporte pedagio",
  "vehicle maintenance": "transporte veiculo",
  "car rental": "transporte",
  "telecommunications": "casa internet telefone",
  "internet": "casa internet",
  "mobile": "casa telefone",
  "utilities": "casa energia agua",
  "electricity": "casa energia luz",
  "water": "casa agua",
  "gas": "casa gas",
  "housing": "casa moradia",
  "rent": "casa aluguel",
  "condominium": "casa condominio",
  "digital services": "assinatura assinaturas",
  "streaming": "assinatura streaming",
  "subscriptions": "assinatura assinaturas",
  "software": "assinatura assinaturas",
  "services": "servicos",
  "shopping": "compras",
  "online shopping": "compras",
  "clothing": "compras roupas",
  "electronics": "compras eletronicos",
  "department store": "compras",
  "health": "saude",
  "pharmacy": "saude farmacia",
  "doctor": "saude medico",
  "medical": "saude medico",
  "dentist": "saude dentista",
  "gym and fitness": "saude academia",
  "personal care": "cuidados pessoais",
  "beauty": "cuidados pessoais beleza",
  "education": "educacao",
  "leisure": "lazer",
  "entertainment": "lazer",
  "gaming": "lazer jogos",
  "travel": "viagem",
  "hotels": "viagem hotel",
  "airfare": "viagem passagem",
  "pets": "pets",
  "gifts": "presentes",
  "donations": "doacoes",
  "loans": "emprestimos emprestimo",
  "income": "receita",
  "salary": "salario receita",
  "taxes": "impostos",
  "bank fees": "tarifas bancarias",
  "interest": "juros",
  "investments": "investimentos",
  "transfers": "transferencia",
  "same person transfer": "transferencia mesma titularidade",
  "pix": "transferencia pix",
  "credit card payment": "pagamento de fatura",
  "credit card bill": "pagamento de fatura",
  "bills": "contas"
};

/**
 * Categorias que quase sempre sao movimentacao interna (transferencia,
 * pagamento de fatura, investimento). Vao para revisao mesmo com destino e
 * categoria resolvidos, para nao duplicar saldo no backend.
 */
const REVIEW_CATEGORIES = new Set([
  "transfers",
  "same person transfer",
  "credit card payment",
  "credit card bill",
  "investments",
  "pix"
]);

export interface PluggyAccountContext {
  type: string;
  name: string;
  itemName: string;
}

export function pluggyCategoryHint(category: string | null | undefined): string | undefined {
  if (!category) return undefined;
  return PLUGGY_CATEGORY_HINTS[category.trim().toLowerCase()];
}

export function isReviewCategory(category: string | null | undefined): boolean {
  return !!category && REVIEW_CATEGORIES.has(category.trim().toLowerCase());
}

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const BANK_BOILERPLATE_PREFIXES = [
  /^pagamento (com|via|de) (pix|conta|boleto|cartao|fatura)( de)?\b/,
  /^pagamento (recebido|efetuado|realizado)\b/,
  /^pix (enviado|recebido|transf(erencia)?)\b/,
  /^transferencia (pix )?(enviada|recebida)\b/,
  /^(cred|deb) pix( chave| qr cod( din)?)?\b/,
  /^compra (no |com )?cartao (de )?debito\b/,
  /^compra (no )?debito\b/,
  /^debito automatico\b/,
  /^(pagamento|compra|transferencia|pix|ted|doc)\b/
];

const BANK_BOILERPLATE_TOKENS = new Set([
  "pix", "ted", "doc", "chave", "cred", "deb", "din", "qr", "cod",
  "enviado", "enviada", "recebido", "recebida", "pagamento", "pagto",
  "transferencia", "transf", "compra", "debito", "credito", "automatico",
  "ltda", "me", "sa", "eireli", "cnpj", "cpf"
]);

/**
 * Tira o jargao de extrato ("Pagamento com Pix", "DEB PIX CHAVE", "COMPRA CARTAO
 * DEBITO") do texto usado para categorizar. Sem isso a palavra "pagamento" puxa
 * a categoria "Pagamento de fatura" e "pix" puxa "Transferencias" para tudo.
 * A descricao gravada no backend continua inteira.
 */
export function stripBankBoilerplate(description: string): string {
  let text = description
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of BANK_BOILERPLATE_PREFIXES) {
      const next = text.replace(pattern, "").trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }

  return text
    .split(" ")
    .filter((token) => token && !BANK_BOILERPLATE_TOKENS.has(token))
    .filter((token) => !/^\d{2,}$/.test(token))
    .join(" ")
    .trim();
}

const INTERNAL_MOVEMENT_CATEGORY = /(fatura|transfer|investimento|aplicac|resgate)/i;

/** Categoria do backend que indica movimentacao interna, nao gasto real. */
export function looksLikeInternalMovement(categoryName: string | undefined): boolean {
  return !!categoryName && INTERNAL_MOVEMENT_CATEGORY.test(categoryName.normalize("NFD").replace(/\p{Diacritic}/gu, ""));
}

const INVOICE_PAYMENT_DESCRIPTION = /\b(fatura|cartoes|cartao de credito|pagamento recebido)\b/i;

/** Descricao de extrato que costuma ser pagamento de fatura de cartao. */
export function looksLikeInvoicePayment(description: string | undefined): boolean {
  return !!description && INVOICE_PAYMENT_DESCRIPTION.test(description.normalize("NFD").replace(/\p{Diacritic}/gu, ""));
}

/**
 * Converte uma transacao da Pluggy para o formato do bot.
 * Sinal: a Pluggy usa `type` (DEBIT/CREDIT) para o sentido. No cartao o
 * `amount` da compra vem positivo e o estorno negativo; na conta e o inverso.
 * Por isso o sinal sai do `type`, nunca do `amount`.
 */
export function toParsedTransaction(
  tx: PluggyTransaction,
  account: PluggyAccountContext,
  mapping?: PluggyAccountMap
): ParsedTransaction {
  const type = tx.type === "CREDIT" ? "income" : "expense";
  const cents = Math.round(Math.abs(tx.amount) * 100);
  const date = tx.date.slice(0, 10);
  const description = cleanDescription(tx.description || tx.descriptionRaw || "Sem descricao");
  const meta = tx.creditCardMetadata;
  const installment = meta?.totalInstallments && meta.totalInstallments > 1
    ? `parcela ${meta.installmentNumber ?? "?"}/${meta.totalInstallments}`
    : undefined;
  const hint = pluggyCategoryHint(tx.category);
  const isCard = account.type === "CREDIT";

  const notes = [
    `Pluggy ${tx.id}`,
    `${account.itemName} ${isCard ? "cartao" : "conta"}`,
    tx.category || "sem categoria Pluggy",
    tx.status === "PENDING" ? "pendente no banco" : undefined,
    installment,
    tx.operationType && tx.operationType !== "OTHER" ? tx.operationType : undefined
  ].filter(Boolean).join(" | ");

  return {
    type,
    description: description.slice(0, 80),
    amount_cents: signedAmount(type, cents),
    date,
    paid: true,
    credit_card_id: mapping?.kind === "credit_card" ? mapping.target_id : undefined,
    credit_card_name: mapping?.kind === "credit_card" ? mapping.target_name : undefined,
    account_id: mapping?.kind === "account" ? mapping.target_id : undefined,
    account_name: mapping?.kind === "account" ? mapping.target_name : undefined,
    notes,
    confidence: 0.7,
    missing_fields: [],
    source: "pluggy",
    raw_text: [stripBankBoilerplate(description), hint, installment].filter(Boolean).join(" ")
  };
}

export interface PluggySyncDeps {
  api: Pick<PluggyApiService, "listAccounts" | "listTransactions">;
  repo: PluggyRepo;
  aliasesRepo: AliasesRepo;
  categorizer: Categorizer;
  pendingRepo: PendingRepo;
  organizzeApi: Pick<OrganizzeApiService, "listTransactions">;
}

export interface PluggySyncOptions {
  items: PluggyItemConfig[];
  /** Data de corte (YYYY-MM-DD). Antes dela nada entra em lote. */
  startDate: string;
  confidenceThreshold?: number;
  /** Janela de sobreposicao no createdAtFrom, em dias, para pegar atrasados. */
  overlapDays?: number;
  today?: () => string;
}

export interface PluggyUnmappedAccount {
  id: string;
  itemName: string;
  name: string;
  type: string;
  subtype?: string;
}

export interface PluggySyncResult {
  batch?: ImportBatch;
  accounts: number;
  candidates: number;
  deferred: number;
  ignored: number;
  alreadyKnown: number;
  unmapped: PluggyUnmappedAccount[];
  errors: Array<{ scope: string; message: string }>;
}

export interface PluggyAccountView {
  account: PluggyAccount;
  itemName: string;
  map?: PluggyAccountMap;
}

interface Candidate {
  tx: PluggyTransaction;
  account: PluggyAccountContext;
  accountId: string;
  map: PluggyAccountMap;
  known: boolean;
}

export class PluggySyncService {
  private running = false;

  constructor(
    private readonly deps: PluggySyncDeps,
    private readonly options: PluggySyncOptions
  ) {}

  get startDate(): string {
    return this.options.startDate;
  }

  get items(): PluggyItemConfig[] {
    return this.options.items;
  }

  /** Busca as contas de todos os itens, atualiza o cache e tenta mapear as novas. */
  async refreshAccounts(): Promise<{ accounts: PluggyAccountView[]; errors: Array<{ scope: string; message: string }> }> {
    const accounts: PluggyAccountView[] = [];
    const errors: Array<{ scope: string; message: string }> = [];

    for (const item of this.options.items) {
      let list: PluggyAccount[];
      try {
        list = await this.deps.api.listAccounts(item.id);
      } catch (error) {
        errors.push({ scope: item.name, message: (error as Error).message });
        continue;
      }

      for (const raw of list) {
        const account: PluggyAccount = { ...raw, itemId: raw.itemId || item.id };
        this.deps.repo.upsertAccount(account, item.name);
        let map = this.deps.repo.getMap(account.id);
        if (!map) {
          const suggestion = this.suggestMapping(account, item.name);
          if (suggestion) {
            this.deps.repo.setMap({ pluggyAccountId: account.id, ...suggestion, auto: true });
            map = this.deps.repo.getMap(account.id);
            logger.info("Pluggy: conta mapeada automaticamente", {
              item: item.name,
              account: account.name,
              kind: suggestion.kind,
              target: suggestion.targetName
            });
          }
        }
        accounts.push({ account, itemName: item.name, map });
      }
    }

    return { accounts, errors };
  }

  /**
   * Sugere conta/cartao do backend para uma conta Pluggy pelo nome do banco.
   * Cartao: qualquer conta CREDIT. Conta: so CHECKING; poupanca fica para o
   * Vitor decidir (ignorar ou mapear a mao).
   */
  suggestMapping(account: PluggyAccount, itemName: string): { kind: "account" | "credit_card"; targetId: number; targetName: string } | undefined {
    const kind = account.type === "CREDIT" ? "credit_card" : "account";
    if (kind === "account" && account.subtype && account.subtype !== "CHECKING_ACCOUNT") return undefined;

    const candidates = [itemName, account.marketingName || "", account.name].filter(Boolean);
    for (const name of candidates) {
      const exact = this.deps.aliasesRepo.findAlias(kind, name);
      if (exact) return { kind, targetId: exact.id, targetName: exact.name };
    }
    const mention = this.deps.aliasesRepo.findMention(kind, itemName);
    if (mention) return { kind, targetId: mention.id, targetName: mention.name };
    return undefined;
  }

  async sync(target: { chatId: number; userId?: number }): Promise<PluggySyncResult> {
    if (this.running) {
      throw new Error("Ja existe uma sincronizacao da Pluggy em andamento.");
    }
    this.running = true;
    try {
      return await this.runSync(target);
    } finally {
      this.running = false;
    }
  }

  private async runSync(target: { chatId: number; userId?: number }): Promise<PluggySyncResult> {
    const today = this.options.today?.() ?? todayIso();
    const startDate = this.options.startDate;
    const overlapDays = this.options.overlapDays ?? 3;
    const result: PluggySyncResult = {
      accounts: 0,
      candidates: 0,
      deferred: 0,
      ignored: 0,
      alreadyKnown: 0,
      unmapped: [],
      errors: []
    };
    const candidates: Candidate[] = [];

    const refreshed = await this.refreshAccounts();
    result.errors.push(...refreshed.errors);
    result.accounts = refreshed.accounts.length;

    for (const view of refreshed.accounts) {
      const { account, itemName, map } = view;
      if (!map) {
        result.unmapped.push({
          id: account.id,
          itemName,
          name: account.name,
          type: account.type,
          subtype: account.subtype ?? undefined
        });
        continue;
      }
      if (map.kind === "ignore") continue;

      const state = this.deps.repo.getSyncState(account.id);
      const createdAtFrom = state?.last_created_at
        ? addDaysIso(state.last_created_at.slice(0, 10), -overlapDays)
        : undefined;

      let transactions: PluggyTransaction[];
      try {
        transactions = await this.deps.api.listTransactions(account.id, { createdAtFrom });
      } catch (error) {
        const message = (error as Error).message;
        result.errors.push({ scope: `${itemName} / ${account.name}`, message });
        this.deps.repo.setSyncState({ accountId: account.id, lastError: message });
        continue;
      }

      let maxCreatedAt = state?.last_created_at;
      const context: PluggyAccountContext = { type: account.type, name: account.name, itemName };

      for (const tx of transactions) {
        if (tx.createdAt && (!maxCreatedAt || tx.createdAt > maxCreatedAt)) maxCreatedAt = tx.createdAt;
        if (this.deps.repo.hasTransaction(tx.id)) {
          result.alreadyKnown += 1;
          continue;
        }

        const date = tx.date.slice(0, 10);
        const type = tx.type === "CREDIT" ? "income" : "expense";
        const base = {
          pluggyId: tx.id,
          accountId: account.id,
          date,
          amountCents: signedAmount(type, Math.round(Math.abs(tx.amount) * 100)),
          description: cleanDescription(tx.description || tx.descriptionRaw || ""),
          pluggyStatus: tx.status,
          pluggyCreatedAt: tx.createdAt,
          payload: tx
        };

        if (date > today) {
          this.deps.repo.recordTransaction({ ...base, status: "deferred" });
          result.deferred += 1;
          continue;
        }
        if (date < startDate) {
          this.deps.repo.recordTransaction({ ...base, status: "ignored" });
          result.ignored += 1;
          continue;
        }

        candidates.push({ tx, account: context, accountId: account.id, map, known: false });
      }

      this.deps.repo.setSyncState({ accountId: account.id, lastCreatedAt: maxCreatedAt });
    }

    // Parcelas futuras cuja data chegou e itens que entraram no corte (se o corte recuou).
    const cached = new Map(this.deps.repo.listAccounts().map((account) => [account.id, account]));
    const revisit = [
      ...this.deps.repo.listDeferredDue(today),
      ...this.deps.repo.listIgnoredSince(startDate)
    ];
    for (const row of revisit) {
      const map = this.deps.repo.getMap(row.account_id);
      if (!map || map.kind === "ignore") continue;
      const account = cached.get(row.account_id);
      if (!account) continue;
      let tx: PluggyTransaction;
      try {
        tx = JSON.parse(row.payload_json) as PluggyTransaction;
      } catch {
        continue;
      }
      candidates.push({
        tx,
        account: { type: account.type, name: account.name, itemName: account.item_name },
        accountId: row.account_id,
        map,
        known: true
      });
    }

    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const parsed = candidates.map((candidate) => ({
      candidate,
      transaction: this.enrich(toParsedTransaction(candidate.tx, candidate.account, candidate.map), candidate.map)
    }));

    const dates = parsed.map((item) => item.transaction.date as string).sort();
    let existing: Awaited<ReturnType<OrganizzeApiService["listTransactions"]>> = [];
    try {
      existing = await this.deps.organizzeApi.listTransactions({ start_date: dates[0], end_date: dates.at(-1) });
    } catch (error) {
      result.errors.push({ scope: "backend", message: `Nao consegui conferir duplicados: ${(error as Error).message}` });
    }

    const threshold = this.options.confidenceThreshold ?? 0.85;
    const importCandidates: ImportCandidate[] = parsed.map(({ candidate, transaction }) => {
      const duplicate = findDuplicate(transaction, existing);
      if (duplicate) {
        return {
          transaction,
          status: "duplicate",
          reason: "Mesmo valor e data proxima ja existem no backend.",
          matched_transaction_id: duplicate.id,
          pluggy_id: candidate.tx.id
        };
      }
      if (isReviewCategory(candidate.tx.category)) {
        return {
          transaction,
          status: "needs_review",
          reason: `Categoria Pluggy "${candidate.tx.category}": pode ser transferencia ou pagamento de fatura.`,
          pluggy_id: candidate.tx.id
        };
      }
      if (looksLikeInternalMovement(transaction.category_name)) {
        return {
          transaction,
          status: "needs_review",
          reason: `Categoria "${transaction.category_name}" indica transferencia ou pagamento de fatura: confira antes de lancar.`,
          pluggy_id: candidate.tx.id
        };
      }
      if (looksLikeInvoicePayment(transaction.description)) {
        return {
          transaction,
          status: "needs_review",
          reason: "Descricao parece pagamento de fatura de cartao: confira antes de lancar.",
          pluggy_id: candidate.tx.id
        };
      }
      if (transaction.missing_fields.length > 0 || transaction.confidence < threshold) {
        return {
          transaction,
          status: "needs_review",
          reason: "Faltam campos ou a categorizacao esta com baixa confianca.",
          pluggy_id: candidate.tx.id
        };
      }
      return { transaction, status: "ready", pluggy_id: candidate.tx.id };
    });

    const batch = this.deps.pendingRepo.saveImportBatch({
      chat_id: target.chatId,
      user_id: target.userId,
      file_name: `Pluggy ${today}`,
      candidates: importCandidates
    });

    for (const { candidate, transaction } of parsed) {
      if (candidate.known) continue;
      this.deps.repo.recordTransaction({
        pluggyId: candidate.tx.id,
        accountId: candidate.accountId,
        date: transaction.date as string,
        amountCents: transaction.amount_cents as number,
        description: transaction.description || "",
        status: "batched",
        pluggyStatus: candidate.tx.status,
        pluggyCreatedAt: candidate.tx.createdAt,
        payload: candidate.tx,
        batchId: batch.id
      });
    }
    this.deps.repo.markBatched(
      parsed.filter((item) => item.candidate.known).map((item) => item.candidate.tx.id),
      batch.id
    );

    result.batch = batch;
    return result;
  }

  /**
   * Passa pelo Categorizer (aliases, padroes aprendidos, intencao por palavra)
   * e depois reforca o destino do mapeamento: a descricao pode citar outro
   * banco ("Pix para Nubank") e nao pode mudar a conta de origem.
   */
  private enrich(parsed: ParsedTransaction, map: PluggyAccountMap): ParsedTransaction {
    // O Categorizer junta raw_text + description; entregamos a descricao sem o
    // jargao de extrato e devolvemos a original depois.
    const enriched = this.deps.categorizer.enrich({
      ...parsed,
      description: stripBankBoilerplate(parsed.description || "") || parsed.description
    });
    enriched.description = parsed.description;

    if (map.kind === "credit_card") {
      enriched.credit_card_id = map.target_id;
      enriched.credit_card_name = map.target_name;
      delete enriched.account_id;
      delete enriched.account_name;
    } else if (map.kind === "account") {
      enriched.account_id = map.target_id;
      enriched.account_name = map.target_name;
      delete enriched.credit_card_id;
      delete enriched.credit_card_name;
    }

    if (!enriched.category_id) {
      const hint = pluggyCategoryHint(extractPluggyCategory(parsed.notes));
      for (const word of (hint || "").split(" ").filter(Boolean)) {
        const alias = this.deps.aliasesRepo.findAlias("category", word);
        if (alias) {
          enriched.category_id = alias.id;
          enriched.category_name = alias.name;
          break;
        }
      }
    }

    enriched.missing_fields = this.deps.categorizer.missingFields(enriched);
    let confidence = 0.7;
    if (enriched.category_id) confidence += 0.1;
    if (enriched.account_id || enriched.credit_card_id) confidence += 0.1;
    confidence -= enriched.missing_fields.length * 0.15;
    enriched.confidence = Math.max(0.05, Math.min(0.99, confidence));
    return enriched;
  }
}

function extractPluggyCategory(notes: string | undefined): string | undefined {
  // notes: "Pluggy <id> | <banco> | <categoria> | ..."
  const parts = (notes || "").split(" | ");
  return parts[2] && parts[2] !== "sem categoria Pluggy" ? parts[2] : undefined;
}
