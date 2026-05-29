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

export interface OrganizzeApiOptions {
  baseUrl: string;
  email: string;
  token: string;
  userAgent: string;
}

export class OrganizzeApiService {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly options: OrganizzeApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;
  }

  async getCatalog(): Promise<OrganizzeCatalog> {
    const [accounts, categories, creditCards] = await Promise.all([
      this.getAccounts(),
      this.getCategories(),
      this.getCreditCards()
    ]);
    return { accounts, categories, creditCards };
  }

  async getAccounts(): Promise<OrganizzeAccount[]> {
    return this.request<OrganizzeAccount[]>("/accounts");
  }

  async getCategories(): Promise<OrganizzeCategory[]> {
    return this.request<OrganizzeCategory[]>("/categories");
  }

  async getCreditCards(): Promise<OrganizzeCreditCard[]> {
    return this.request<OrganizzeCreditCard[]>("/credit_cards");
  }

  async listTransactions(params: { start_date?: string; end_date?: string; account_id?: number } = {}): Promise<OrganizzeTransaction[]> {
    const search = new URLSearchParams();
    if (params.start_date) search.set("start_date", params.start_date);
    if (params.end_date) search.set("end_date", params.end_date);
    if (params.account_id !== undefined) search.set("account_id", String(params.account_id));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return this.request<OrganizzeTransaction[]>(`/transactions${suffix}`);
  }

  async createTransaction(payload: OrganizzeTransactionCreatePayload): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>("/transactions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async updateTransaction(id: number, payload: OrganizzeTransactionUpdatePayload): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>(`/transactions/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async createCategory(payload: OrganizzeCategoryCreatePayload): Promise<OrganizzeCategory> {
    return this.request<OrganizzeCategory>("/categories", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async updateAccount(id: number, payload: OrganizzeAccountUpdatePayload): Promise<OrganizzeAccount> {
    return this.request<OrganizzeAccount>(`/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async updateCreditCard(id: number, payload: OrganizzeCreditCardUpdatePayload): Promise<OrganizzeCreditCard> {
    return this.request<OrganizzeCreditCard>(`/credit_cards/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async listCreditCardInvoices(creditCardId: number, params: { start_date?: string; end_date?: string } = {}): Promise<OrganizzeCreditCardInvoice[]> {
    const search = new URLSearchParams();
    if (params.start_date) search.set("start_date", params.start_date);
    if (params.end_date) search.set("end_date", params.end_date);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return this.request<OrganizzeCreditCardInvoice[]>(`/credit_cards/${creditCardId}/invoices${suffix}`);
  }

  async getCreditCardInvoice(creditCardId: number, invoiceId: number): Promise<OrganizzeCreditCardInvoice> {
    return this.request<OrganizzeCreditCardInvoice>(`/credit_cards/${creditCardId}/invoices/${invoiceId}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        "User-Agent": this.options.userAgent,
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Organizze API ${response.status} ${response.statusText}: ${body}`);
    }

    return (await response.json()) as T;
  }
}
