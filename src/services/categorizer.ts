import type { ParsedTransaction } from "../types/finance.js";
import type { AliasesRepo } from "../repositories/aliases-repo.js";
import type { LearningRepo } from "../repositories/learning-repo.js";

export interface CategorizerDefaults {
  accountId?: number;
  creditCardId?: number;
  categoryId?: number;
}

const CATEGORY_INTENT_ALIASES: Array<[RegExp, string]> = [
  [/\b(emprestei|emprestado|emprestada|emprestimo|emprestimos)\b/i, "emprestimos"],
  [/\b(mercado|supermercado|compras do mes|feira)\b/i, "mercado"],
  [/\b(uber|99|taxi|transporte|onibus|metro|viacao|rota transport)\b/i, "transporte"],
  [/\b(ifood|restaurante|lanche|lanchonete|hamburguer|burger|almoco|jantar|acai|sorvete)\b/i, "alimentacao"],
  [/\b(netflix|spotify|assinatura|anthropic|claude|google cloud|hostgator)\b/i, "assinaturas"],
  [/\b(farmacia|remedio|consulta|medico|dentista|odonto|saude)\b/i, "saude"]
];

export class Categorizer {
  constructor(
    private readonly aliasesRepo: AliasesRepo,
    private readonly defaults: CategorizerDefaults,
    private readonly learningRepo?: LearningRepo
  ) {}

  enrich(transaction: ParsedTransaction): ParsedTransaction {
    const text = `${transaction.raw_text || ""} ${transaction.description || ""}`;
    const card = findExplicitTarget(this.aliasesRepo, "credit_card", text) || this.aliasesRepo.findMention("credit_card", text);
    const account = card ? undefined : findExplicitTarget(this.aliasesRepo, "account", text) || this.aliasesRepo.findMention("account", text);
    const category = this.aliasesRepo.findMention("category", text) || this.findCategoryByIntent(text);
    const learned = this.learningRepo?.findMatch(text);
    const learnedDestinationAllowed = !!learned && learned.seen_count >= 2 && !card && !account && !transaction.account_id && !transaction.credit_card_id;
    const cardId = transaction.credit_card_id
      ?? card?.id
      ?? (learnedDestinationAllowed ? learned?.credit_card_id : undefined)
      ?? this.defaults.creditCardId;
    const accountId = cardId
      ? undefined
      : transaction.account_id
        ?? account?.id
        ?? (learnedDestinationAllowed ? learned?.account_id : undefined)
        ?? this.defaults.accountId;
    const categoryId = transaction.category_id ?? category?.id ?? learned?.category_id ?? this.defaults.categoryId;
    const unresolvedCategoryName = categoryId
      ? undefined
      : !category && !transaction.category_id ? extractNamedHint(text, "categoria") : transaction.unresolved_category_name;
    const accountById = accountId ? this.aliasesRepo.findCatalogById("account", accountId) : undefined;
    const cardById = cardId ? this.aliasesRepo.findCatalogById("credit_card", cardId) : undefined;
    const categoryById = categoryId ? this.aliasesRepo.findCatalogById("category", categoryId) : undefined;
    const learnedApplied = categoryId === learned?.category_id
      || accountId === learned?.account_id
      || cardId === learned?.credit_card_id;

    const enriched: ParsedTransaction = {
      ...transaction,
      account_id: accountId,
      credit_card_id: cardId,
      category_id: categoryId,
      account_name: transaction.account_name ?? account?.name ?? accountById?.name ?? (accountId === learned?.account_id ? learned?.account_name : undefined),
      credit_card_name: transaction.credit_card_name ?? card?.name ?? cardById?.name ?? (cardId === learned?.credit_card_id ? learned?.credit_card_name : undefined),
      category_name: transaction.category_name ?? category?.name ?? categoryById?.name ?? (categoryId === learned?.category_id ? learned?.category_name : undefined),
      unresolved_category_name: unresolvedCategoryName
    };

    if (enriched.credit_card_id) {
      delete enriched.account_id;
      delete enriched.account_name;
    }

    enriched.missing_fields = this.missingFields(enriched);
    enriched.confidence = this.adjustConfidence(enriched, transaction.confidence, learnedApplied);
    return enriched;
  }

  missingFields(transaction: ParsedTransaction): string[] {
    const missing: string[] = [];
    if (!transaction.description) missing.push("description");
    if (transaction.amount_cents === undefined) missing.push("amount_cents");
    if (!transaction.date) missing.push("date");
    if (!transaction.category_id) missing.push("category_id");
    if (!transaction.account_id && !transaction.credit_card_id) missing.push("account_id_or_credit_card_id");
    return missing;
  }

  private adjustConfidence(transaction: ParsedTransaction, base: number, learnedApplied: boolean): number {
    let confidence = base;
    if (transaction.category_id) confidence += 0.1;
    if (transaction.account_id || transaction.credit_card_id) confidence += 0.1;
    if (learnedApplied) confidence += 0.05;
    if (transaction.missing_fields.length > 0) confidence -= transaction.missing_fields.length * 0.15;
    return Math.max(0.05, Math.min(0.99, confidence));
  }

  private findCategoryByIntent(text: string) {
    for (const [pattern, alias] of CATEGORY_INTENT_ALIASES) {
      if (pattern.test(text)) {
        return this.aliasesRepo.findAlias("category", alias);
      }
    }
    return undefined;
  }
}

function findExplicitTarget(aliasesRepo: AliasesRepo, kind: "account" | "credit_card", text: string) {
  const words = kind === "credit_card"
    ? ["cartao", "cartao de credito", "credito", "no", "na"]
    : ["conta", "conta do", "conta da", "no", "na"];

  for (const target of aliasesRepo.getCatalog(kind)) {
    const aliases = [target.name, aliasesRepo.normalizeAlias(target.name).replace(/\s+/g, "")];
    for (const alias of aliases) {
      for (const word of words) {
        const pattern = new RegExp(`\\b${word}\\s+(?:de\\s+credito\\s+)?${escapeRegExp(alias)}\\b`, "iu");
        if (pattern.test(normalizeForPattern(text))) return target;
      }
    }
  }

  return undefined;
}

function normalizeForPattern(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedHint(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`\\b${label}\\s+([\\p{Letter}\\p{Number}\\s]{3,40})`, "iu"));
  const value = match?.[1]
    ?.replace(/\b(conta|cartao|cart[aã]o|no|na|em|dia|hoje|ontem|amanh[aã]|valor|r\\$)\\b.*$/i, "")
    .trim();
  return value || undefined;
}
