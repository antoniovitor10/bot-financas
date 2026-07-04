import type {
  OrganizzeAccount,
  OrganizzeCatalog,
  OrganizzeCategory,
  OrganizzeCategoryCreatePayload,
  OrganizzeCreditCard,
  OrganizzeCreditCardInvoice,
  OrganizzeCreditCardUpdatePayload,
  OrganizzeAccountUpdatePayload,
  OrganizzeTransaction,
  OrganizzeTransactionCreatePayload,
  OrganizzeTransactionUpdatePayload
} from "../types/organizze.js";

export interface FinControlApiOptions {
  baseUrl: string;
  email: string;
  password: string;
}

interface FinControlAccount {
  id: string;
  name: string;
  type: string;
  balance: number;
  institutionName?: string | null;
}

interface FinControlCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
}

interface FinControlTransaction {
  id: string;
  description: string;
  amount: number;
  type: "Credit" | "Debit";
  date: string;
  accountId: string;
  categoryId?: string | null;
}

/**
 * Adaptador: expõe a mesma interface pública do OrganizzeApiService,
 * mas conversa com a API do FinControl.
 *
 * Ids: o bot inteiro trabalha com ids numéricos (herança do Organizze).
 * GUIDs do FinControl viram números determinísticos (hash dos 12 primeiros
 * hex dígitos), então aliases salvos continuam válidos entre restarts.
 */
export class FinControlApiService {
  private readonly baseUrl: string;
  private token: string | null = null;
  private readonly numToGuid = new Map<number, string>();

  constructor(private readonly options: FinControlApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  // ── mapeamento de ids ──
  private numId(guid: string): number {
    const n = parseInt(guid.replace(/-/g, "").slice(0, 12), 16) % 2_000_000_000;
    this.numToGuid.set(n, guid);
    return n;
  }

  private guidOf(num: number, kind: string): string {
    const guid = this.numToGuid.get(num);
    if (!guid) {
      throw new Error(`${kind} ${num} não encontrado no catálogo do FinControl. Rode /sync e tente de novo.`);
    }
    return guid;
  }

  // ── catálogo ──
  async getCatalog(): Promise<OrganizzeCatalog> {
    const [accounts, categories, creditCards] = await Promise.all([
      this.getAccounts(),
      this.getCategories(),
      this.getCreditCards()
    ]);
    return { accounts, categories, creditCards };
  }

  async getAccounts(): Promise<OrganizzeAccount[]> {
    const all = await this.request<FinControlAccount[]>("/accounts/");
    return all
      .filter((a) => a.type !== "CreditCard")
      .map((a) => ({
        id: this.numId(a.id),
        name: a.name,
        type: a.type,
        archived: false,
        balance_cents: Math.round(a.balance * 100)
      }));
  }

  async getCreditCards(): Promise<OrganizzeCreditCard[]> {
    const all = await this.request<FinControlAccount[]>("/accounts/");
    return all
      .filter((a) => a.type === "CreditCard")
      .map((a) => ({ id: this.numId(a.id), name: a.name, archived: false }));
  }

  async getCategories(): Promise<OrganizzeCategory[]> {
    const all = await this.request<FinControlCategory[]>("/categories/");
    return all.map((c) => ({ id: this.numId(c.id), name: c.name, color: c.color }));
  }

  // ── transações ──
  async listTransactions(params: { start_date?: string; end_date?: string; account_id?: number } = {}): Promise<OrganizzeTransaction[]> {
    const search = new URLSearchParams({ pageSize: "100" });
    if (params.start_date) search.set("startDate", params.start_date);
    if (params.end_date) search.set("endDate", params.end_date);
    if (params.account_id !== undefined) search.set("accountId", this.guidOf(params.account_id, "Conta"));
    const page = await this.request<{ items: FinControlTransaction[] }>(`/transactions/?${search.toString()}`);
    return (page.items ?? []).map((t) => this.toOrganizzeTransaction(t));
  }

  async createTransaction(payload: OrganizzeTransactionCreatePayload): Promise<OrganizzeTransaction> {
    const numAccount = payload.credit_card_id ?? payload.account_id;
    if (numAccount === undefined) {
      throw new Error("Transação sem conta: informe uma conta ou cartão.");
    }
    const body = {
      accountId: this.guidOf(numAccount, "Conta"),
      categoryId: payload.category_id ? this.guidOf(payload.category_id, "Categoria") : null,
      description: payload.description,
      amount: Math.abs(payload.amount_cents) / 100,
      type: payload.amount_cents < 0 ? "Debit" : "Credit",
      date: payload.date,
      paymentMethod: payload.credit_card_id ? "Cartão de crédito" : null
    };
    const created = await this.request<FinControlTransaction>("/transactions/", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return this.toOrganizzeTransaction(created);
  }

  async updateTransaction(_id: number, payload: OrganizzeTransactionUpdatePayload): Promise<OrganizzeTransaction> {
    if (payload.paid !== undefined && Object.keys(payload).length <= 2) {
      // FinControl não tem o conceito de "pagar" transação agendada — trate como concluída.
      throw new Error("No FinControl toda transação registrada já entra como efetivada — nada a pagar aqui.");
    }
    throw new Error("Edição de transação ainda não é suportada no backend FinControl. Exclua e registre de novo.");
  }

  // ── categorias ──
  async createCategory(payload: OrganizzeCategoryCreatePayload): Promise<OrganizzeCategory> {
    const created = await this.request<FinControlCategory>("/categories/", {
      method: "POST",
      body: JSON.stringify({ name: payload.name, icon: "🏷️", color: "#0e5b43" })
    });
    return { id: this.numId(created.id), name: created.name, color: created.color };
  }

  // ── não suportado (ainda) no FinControl ──
  async updateAccount(): Promise<OrganizzeAccount> {
    throw new Error("Edição de conta pelo bot não é suportada no backend FinControl — use o app.");
  }

  async updateCreditCard(): Promise<OrganizzeCreditCard> {
    throw new Error("Edição de cartão pelo bot não é suportada no backend FinControl — use o app.");
  }

  async listCreditCardInvoices(): Promise<OrganizzeCreditCardInvoice[]> {
    throw new Error("Faturas pelo bot ainda não são suportadas no backend FinControl — veja em Faturas no app.");
  }

  async getCreditCardInvoice(): Promise<OrganizzeCreditCardInvoice> {
    throw new Error("Faturas pelo bot ainda não são suportadas no backend FinControl — veja em Faturas no app.");
  }

  // ── infra ──
  private toOrganizzeTransaction(t: FinControlTransaction): OrganizzeTransaction {
    const cents = Math.round(t.amount * 100);
    return {
      id: this.numId(t.id),
      description: t.description,
      date: t.date,
      paid: true,
      amount_cents: t.type === "Debit" ? -cents : cents,
      total_installments: 1,
      installment: 1,
      recurring: false,
      account_id: this.numId(t.accountId),
      category_id: t.categoryId ? this.numId(t.categoryId) : 0
    };
  }

  private async login(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.options.email, password: this.options.password })
    });
    if (!response.ok) {
      throw new Error(`FinControl login falhou: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { accessToken: string };
    this.token = data.accessToken;
    return this.token;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = this.token ?? (await this.login());
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers || {})
      }
    });

    if (response.status === 401 && retry) {
      this.token = null;
      return this.request<T>(path, init, false);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FinControl API ${response.status} ${response.statusText}: ${body}`);
    }

    return (await response.json()) as T;
  }
}
