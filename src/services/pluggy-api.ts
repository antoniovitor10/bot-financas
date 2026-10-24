import type { PluggyAccount, PluggyItem, PluggyTransaction } from "../types/pluggy.js";

export interface PluggyApiOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface PageResponse<T> {
  results: T[];
  next?: string | null;
}

// A apiKey da Pluggy vale 2 horas. Renovamos antes disso e tambem em 401/403.
const API_KEY_TTL_MS = 100 * 60 * 1000;

/**
 * Cliente minimo da API da Pluggy (api.pluggy.ai), so com o que o bot usa.
 *
 * Fatos confirmados em 24/10/2026 contra uma conta Meu Pluggy:
 * - POST /auth devolve { apiKey }, usada no header X-API-KEY.
 * - GET /items (listar) da 403; por isso os itens vem do .env.
 * - GET /transactions (v1) esta depreciado (410). O v2 pagina por cursor:
 *   a resposta traz `next` como query string ("?accountId=...&after=..."),
 *   que deve ser anexada a /v2/transactions. Pagina fixa de 500 itens.
 * - O v2 aceita `accountId` e `createdAtFrom` (data ISO). `from`, `to`,
 *   `pageSize`, `page`, `cursor`, `createdAtTo` e `updatedAtFrom` dao 400.
 */
export class PluggyApiService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private apiKey?: string;
  private apiKeyIssuedAt = 0;

  constructor(private readonly options: PluggyApiOptions) {
    this.baseUrl = (options.baseUrl || "https://api.pluggy.ai").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async getItem(itemId: string): Promise<PluggyItem> {
    return this.get<PluggyItem>(`/items/${encodeURIComponent(itemId)}`);
  }

  async listAccounts(itemId: string): Promise<PluggyAccount[]> {
    const page = await this.get<PageResponse<PluggyAccount>>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    return page.results;
  }

  /**
   * Lista todas as transacoes de uma conta seguindo o cursor `next` ate acabar.
   * `createdAtFrom` (YYYY-MM-DD) filtra pela data em que a Pluggy registrou a
   * transacao, nao pela data da compra. E o unico filtro temporal aceito no v2.
   */
  async listTransactions(accountId: string, params: { createdAtFrom?: string } = {}): Promise<PluggyTransaction[]> {
    const query = new URLSearchParams({ accountId });
    if (params.createdAtFrom) query.set("createdAtFrom", params.createdAtFrom);

    const results: PluggyTransaction[] = [];
    const seen = new Set<string>();
    let path: string | undefined = `/v2/transactions?${query.toString()}`;
    let guard = 0;

    while (path && guard < 200) {
      guard += 1;
      const page: PageResponse<PluggyTransaction> = await this.get<PageResponse<PluggyTransaction>>(path);
      for (const transaction of page.results) {
        if (seen.has(transaction.id)) continue;
        seen.add(transaction.id);
        results.push(transaction);
      }
      path = page.next ? this.nextPath(page.next) : undefined;
      if (page.results.length === 0) break;
    }

    return results;
  }

  private nextPath(next: string): string {
    if (next.startsWith("http")) {
      const url = new URL(next);
      return `${url.pathname}${url.search}`;
    }
    if (next.startsWith("?")) return `/v2/transactions${next}`;
    if (next.startsWith("/")) return next;
    return `/v2/transactions?${next}`;
  }

  private async authenticate(): Promise<string> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: this.options.clientId, clientSecret: this.options.clientSecret })
    });

    if (!response.ok) {
      throw new Error(`Pluggy auth falhou: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { apiKey?: string };
    if (!body.apiKey) {
      throw new Error("Pluggy auth nao devolveu apiKey.");
    }

    this.apiKey = body.apiKey;
    this.apiKeyIssuedAt = Date.now();
    return body.apiKey;
  }

  private async currentApiKey(force = false): Promise<string> {
    if (!force && this.apiKey && Date.now() - this.apiKeyIssuedAt < API_KEY_TTL_MS) {
      return this.apiKey;
    }
    return this.authenticate();
  }

  private async get<T>(path: string, retry = true): Promise<T> {
    const apiKey = await this.currentApiKey();
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey }
    });

    if ((response.status === 401 || response.status === 403) && retry) {
      await this.currentApiKey(true);
      return this.get<T>(path, false);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Pluggy GET ${path.split("?")[0]} falhou: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
