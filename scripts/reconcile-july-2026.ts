import { config } from "../src/config.js";

type TxInput = {
  key: string;
  date: string;
  description: string;
  amount_cents: number;
  category_id: number;
  account_id?: number;
  credit_card_id?: number;
  installments?: { total: number; current?: number };
  notes?: string;
};

type ApiTransaction = {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  account_id: number;
  credit_card_id?: number | null;
  credit_card_invoice_id?: number | null;
  notes?: string | null;
};

const apply = process.argv.includes("--apply");
const baseUrl = config.organizze.baseUrl.replace(/\/$/, "");
const auth = `Basic ${Buffer.from(`${config.organizze.email}:${config.organizze.token}`).toString("base64")}`;

const ACCOUNT = {
  mercadoPago: 6272886,
  caixa: 6272892,
  balao: 6277459,
  picpay: 10118745,
  pj: 10025309
} as const;

const CARD = {
  inter: 1723006,
  mercadoPago: 1723018,
  nubank: 1723021,
  picpay: 1723007,
  amazon: 2160387
} as const;

const CATEGORY = {
  alimentacao: 79404716,
  assinaturas: 79404730,
  bares: 79404709,
  casa: 79404720,
  compras: 79404729,
  duda: 153685499,
  dudaMeu: 157307316,
  gasolina: 79404733,
  gustavo: 164714868,
  ia: 164247509,
  impostos: 79404731,
  lanches: 114175492,
  lazer: 79404714,
  outros: 79404724,
  pagamentoFatura: 79404722,
  presentes: 79404717,
  projetos: 153864764,
  receitaCompartilhada: 164258372,
  roupas: 79404710,
  salario: 79404728,
  saude: 79404719,
  transferencias: 79404732,
  acertos: 164258344,
  transporte: 79404733,
  wordpress: 113894339
} as const;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": config.organizze.userAgent,
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const normalize = (value: string | undefined | null): string =>
  (value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const marker = (key: string): string => `reconcile-july-2026:${key}`;

async function loadTransactions(): Promise<ApiTransaction[]> {
  const regular = await request<ApiTransaction[]>("/transactions?start_date=2026-05-01&end_date=2026-12-31");
  const invoiceTransactions: ApiTransaction[] = [];
  for (const cardId of Object.values(CARD)) {
    const invoices = await request<Array<{ id: number }>>(
      `/credit_cards/${cardId}/invoices?start_date=2026-05-01&end_date=2026-12-31`
    );
    for (const invoice of invoices) {
      const detailed = await request<{ transactions?: ApiTransaction[] }>(
        `/credit_cards/${cardId}/invoices/${invoice.id}`
      );
      invoiceTransactions.push(...(detailed.transactions || []));
    }
  }
  return [...new Map([...regular, ...invoiceTransactions].map((transaction) => [transaction.id, transaction])).values()];
}

let existing = await loadTransactions();
const created: Array<{ key: string; id: number }> = [];
const skipped: string[] = [];
const updated: string[] = [];
const removed: string[] = [];
const payments: string[] = [];

async function ensureTransaction(input: TxInput): Promise<void> {
  const reconciliationMarker = marker(input.key);
  const found = existing.find((transaction) =>
    transaction.notes?.includes(reconciliationMarker) ||
    (
      transaction.date === input.date &&
      transaction.amount_cents === input.amount_cents &&
      normalize(transaction.description) === normalize(input.description) &&
      (
        input.credit_card_id
          ? transaction.credit_card_id === input.credit_card_id
          : transaction.account_id === input.account_id
      )
    )
  );
  if (found) {
    skipped.push(`${input.key} -> #${found.id}`);
    return;
  }
  if (!apply) {
    console.log(`CREATE ${input.key}: ${input.date} ${input.amount_cents} ${input.description}`);
    return;
  }
  const payload = {
    description: input.description,
    amount_cents: input.amount_cents,
    date: input.date,
    paid: true,
    account_id: input.account_id,
    credit_card_id: input.credit_card_id,
    category_id: input.category_id,
    notes: [input.notes, reconciliationMarker].filter(Boolean).join(" | "),
    installments_attributes: input.installments
      ? { periodicity: "monthly", total: input.installments.total, current: input.installments.current || 1 }
      : undefined
  };
  const transaction = await request<ApiTransaction>("/transactions", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  created.push({ key: input.key, id: transaction.id });
  existing.push(transaction);
}

async function updateTransaction(
  id: number,
  payload: Record<string, unknown>,
  label: string
): Promise<void> {
  if (!apply) {
    console.log(`UPDATE #${id} ${label}: ${JSON.stringify(payload)}`);
    return;
  }
  await request(`/transactions/${id}`, { method: "PUT", body: JSON.stringify(payload) });
  updated.push(`#${id} ${label}`);
}

async function deleteTransaction(id: number, label: string): Promise<void> {
  if (!existing.some((transaction) => transaction.id === id)) {
    skipped.push(`delete ${label}: already absent`);
    return;
  }
  if (!apply) {
    console.log(`DELETE #${id} ${label}`);
    return;
  }
  try {
    await request(`/transactions/${id}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("-> 404:")) throw error;
  }
  existing = existing.filter((transaction) => transaction.id !== id);
  removed.push(`#${id} ${label}`);
}

async function ensureInvoicePayment(
  cardId: number,
  invoiceId: number,
  accountId: number,
  amountCents: number,
  date: string,
  description: string
): Promise<void> {
  const current = await request<ApiTransaction[]>(`/credit_cards/${cardId}/invoices/${invoiceId}/payments`);
  if (current.some((payment) => Math.abs(payment.amount_cents) === Math.abs(amountCents) && payment.account_id === accountId)) {
    skipped.push(`payment ${cardId}/${invoiceId} ${amountCents}`);
    return;
  }
  if (!apply) {
    console.log(`PAY card=${cardId} invoice=${invoiceId} account=${accountId} amount=${amountCents}`);
    return;
  }
  await request(`/credit_cards/${cardId}/invoices/${invoiceId}/payments`, {
    method: "POST",
    body: JSON.stringify({
      account_id: accountId,
      category_id: CATEGORY.pagamentoFatura,
      date,
      description,
      amount_cents: -Math.abs(amountCents),
      paid: true,
      notes: marker(`payment-${cardId}-${invoiceId}`)
    })
  });
  payments.push(`${description}: ${amountCents}`);
}

const cardTransactions: TxInput[] = [
  // PicPay, fatura 05/08. Parcelas que ja existiam foram omitidas.
  { key: "picpay-20260723-keila-6", date: "2026-07-23", description: "Keilasantosda", amount_cents: -600, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260723-ifd-joao", date: "2026-07-23", description: "IFD Joao Batista de Souza", amount_cents: -4610, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260723-rosa", date: "2026-07-23", description: "Rosa Elze - gasolina", amount_cents: -2522, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260721-trailer", date: "2026-07-21", description: "MP Trailer do Mano", amount_cents: -4133, category_id: CATEGORY.alimentacao, credit_card_id: CARD.picpay },
  { key: "picpay-20260720-trailer", date: "2026-07-20", description: "MP Trailer do Mano", amount_cents: -5835, category_id: CATEGORY.alimentacao, credit_card_id: CARD.picpay },
  { key: "picpay-20260720-ifd-diego", date: "2026-07-20", description: "IFD Diego Silva Santos", amount_cents: -2144, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260719-hostinger", date: "2026-07-19", description: "Hostinger.com", amount_cents: -10899, category_id: CATEGORY.ia, credit_card_id: CARD.picpay },
  { key: "picpay-20260719-vinicius", date: "2026-07-19", description: "Vinicius de Matos", amount_cents: -700, category_id: CATEGORY.outros, credit_card_id: CARD.picpay },
  { key: "picpay-20260719-dom-burguer", date: "2026-07-19", description: "Dom Burguer", amount_cents: -4500, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260719-eli", date: "2026-07-19", description: "Eli Festas Comercio", amount_cents: -3000, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260716-napoleon", date: "2026-07-16", description: "IG Napoleon", amount_cents: -6499, category_id: CATEGORY.assinaturas, credit_card_id: CARD.picpay },
  { key: "picpay-20260716-keila", date: "2026-07-16", description: "Keilasantosda", amount_cents: -1300, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260715-trailer", date: "2026-07-15", description: "MP Trailer do Mano", amount_cents: -4500, category_id: CATEGORY.alimentacao, credit_card_id: CARD.picpay },
  { key: "picpay-20260715-drogasil", date: "2026-07-15", description: "Drogasil 3160", amount_cents: -2700, category_id: CATEGORY.saude, credit_card_id: CARD.picpay },
  { key: "picpay-20260714-panificacao", date: "2026-07-14", description: "Panificacao e Mercadinho", amount_cents: -2114, category_id: CATEGORY.alimentacao, credit_card_id: CARD.picpay },
  { key: "picpay-20260714-keila", date: "2026-07-14", description: "Keilasantosda", amount_cents: -1100, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260713-detran", date: "2026-07-13", description: "Grupo Alpha Detran", amount_cents: -2401, category_id: CATEGORY.duda, credit_card_id: CARD.picpay },
  { key: "picpay-20260713-keila", date: "2026-07-13", description: "Keilasantosda", amount_cents: -1320, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260713-luciano", date: "2026-07-13", description: "Luciano Santiago", amount_cents: -8540, category_id: CATEGORY.alimentacao, credit_card_id: CARD.picpay },
  { key: "picpay-20260713-app-u", date: "2026-07-13", description: "App U", amount_cents: -6750, category_id: CATEGORY.roupas, credit_card_id: CARD.picpay, installments: { total: 2 } },
  { key: "picpay-20260712-sushi", date: "2026-07-12", description: "MP Loucos por Sushi", amount_cents: -3450, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260708-farmacias", date: "2026-07-08", description: "Farmaciasdo", amount_cents: -6201, category_id: CATEGORY.saude, credit_card_id: CARD.picpay },
  { key: "picpay-20260708-wellhub-antonio", date: "2026-07-08", description: "Wellhub Antonio Vitor", amount_cents: -14999, category_id: CATEGORY.saude, credit_card_id: CARD.picpay },
  { key: "picpay-20260708-wellhub-gustavo", date: "2026-07-08", description: "Wellhub Gustavo Mendonca", amount_cents: -14999, category_id: CATEGORY.gustavo, credit_card_id: CARD.picpay, notes: "Gustavo ja reembolsou." },
  { key: "picpay-20260708-wellhub-duda-meu", date: "2026-07-08", description: "Wellhub Maria Eduarda - parte minha", amount_cents: -1499, category_id: CATEGORY.dudaMeu, credit_card_id: CARD.picpay },
  { key: "picpay-20260708-wellhub-duda", date: "2026-07-08", description: "Wellhub Maria Eduarda - parte Duda", amount_cents: -8500, category_id: CATEGORY.duda, credit_card_id: CARD.picpay, notes: "Divisao arredondada para preservar total da fatura: 14,99 + 85,00." },
  { key: "picpay-20260708-simone", date: "2026-07-08", description: "MP Simone", amount_cents: -1590, category_id: CATEGORY.presentes, credit_card_id: CARD.picpay },
  { key: "picpay-20260707-rede-jg", date: "2026-07-07", description: "Rede JG Avenida Comercio", amount_cents: -2500, category_id: CATEGORY.duda, credit_card_id: CARD.picpay },
  { key: "picpay-20260707-ml-decomod", date: "2026-07-07", description: "MercadoLivre Deccomod", amount_cents: -11041, category_id: CATEGORY.compras, credit_card_id: CARD.picpay },
  { key: "picpay-20260707-subway", date: "2026-07-07", description: "Subway Unit", amount_cents: -3950, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260707-ml-4099", date: "2026-07-07", description: "MercadoLivre", amount_cents: -4099, category_id: CATEGORY.compras, credit_card_id: CARD.picpay },
  { key: "picpay-20260707-coffee", date: "2026-07-07", description: "The Coffee Roasting", amount_cents: -400, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260706-uber", date: "2026-07-06", description: "Uber", amount_cents: -2017, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260705-evidencia-30", date: "2026-07-05", description: "Evidencia Modas", amount_cents: -3000, category_id: CATEGORY.lazer, credit_card_id: CARD.picpay },
  { key: "picpay-20260705-evidencia-20", date: "2026-07-05", description: "Evidencia Modas", amount_cents: -2000, category_id: CATEGORY.lazer, credit_card_id: CARD.picpay },
  { key: "picpay-20260705-imperio", date: "2026-07-05", description: "Imperio e Comercio", amount_cents: -5600, category_id: CATEGORY.lazer, credit_card_id: CARD.picpay },
  { key: "picpay-20260705-ariele", date: "2026-07-05", description: "Ariele Gomes Santos", amount_cents: -2000, category_id: CATEGORY.lazer, credit_card_id: CARD.picpay },
  { key: "picpay-20260705-danilo", date: "2026-07-05", description: "MP Danilo Florenc", amount_cents: -1000, category_id: CATEGORY.lazer, credit_card_id: CARD.picpay },
  { key: "picpay-20260704-rede-jg", date: "2026-07-04", description: "Rede JG Avenida Comercio", amount_cents: -2000, category_id: CATEGORY.duda, credit_card_id: CARD.picpay },
  { key: "picpay-20260704-sao-luiz", date: "2026-07-04", description: "Supermercado Sao Luiz", amount_cents: -5743, category_id: CATEGORY.duda, credit_card_id: CARD.picpay },
  { key: "picpay-20260704-claude", date: "2026-07-04", description: "Google Claude by Anthropic", amount_cents: -68750, category_id: CATEGORY.ia, credit_card_id: CARD.picpay },
  { key: "picpay-20260703-havan", date: "2026-07-03", description: "Havan Aracaju", amount_cents: -3497, category_id: CATEGORY.compras, credit_card_id: CARD.picpay },
  { key: "picpay-20260702-uber-1648", date: "2026-07-02", description: "Uber", amount_cents: -1648, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260702-ml", date: "2026-07-02", description: "MercadoLivre", amount_cents: -14840, category_id: CATEGORY.compras, credit_card_id: CARD.picpay },
  { key: "picpay-20260702-uber-2471", date: "2026-07-02", description: "Uber", amount_cents: -2471, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260701-lucilene", date: "2026-07-01", description: "Lucilenesenados", amount_cents: -5850, category_id: CATEGORY.compras, credit_card_id: CARD.picpay },
  { key: "picpay-20260701-senzai", date: "2026-07-01", description: "Senzai Concept", amount_cents: -4976, category_id: CATEGORY.duda, credit_card_id: CARD.picpay },
  { key: "picpay-20260701-uber-3542", date: "2026-07-01", description: "Uber", amount_cents: -3542, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260701-uber-1239", date: "2026-07-01", description: "Uber", amount_cents: -1239, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260630-drogasil", date: "2026-06-30", description: "Drogasil 3864", amount_cents: -6218, category_id: CATEGORY.dudaMeu, credit_card_id: CARD.picpay, installments: { total: 2 } },
  { key: "picpay-20260630-eko", date: "2026-06-30", description: "Eko - gasolina", amount_cents: -2291, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260630-uber", date: "2026-06-30", description: "Uber", amount_cents: -2566, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260630-iflores", date: "2026-06-30", description: "MP Franca iFlores", amount_cents: -100, category_id: CATEGORY.presentes, credit_card_id: CARD.picpay },
  { key: "picpay-20260629-boteco-60", date: "2026-06-29", description: "Boteco Seo Chico", amount_cents: -6000, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260629-uber-1590", date: "2026-06-29", description: "Uber", amount_cents: -1590, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },
  { key: "picpay-20260629-boteco-68", date: "2026-06-29", description: "Boteco Seo Chico", amount_cents: -6800, category_id: CATEGORY.lanches, credit_card_id: CARD.picpay },
  { key: "picpay-20260629-uber-3635", date: "2026-06-29", description: "Uber", amount_cents: -3635, category_id: CATEGORY.transporte, credit_card_id: CARD.picpay },

  // Inter, fatura 02/08.
  { key: "inter-20260711-youtube", date: "2026-07-11", description: "Google YouTube", amount_cents: -199, category_id: CATEGORY.assinaturas, credit_card_id: CARD.inter },
  { key: "inter-20260704-iof-1", date: "2026-07-04", description: "IOF internacional 1", amount_cents: -111, category_id: CATEGORY.impostos, credit_card_id: CARD.inter },
  { key: "inter-20260704-iof-2", date: "2026-07-04", description: "IOF internacional 2", amount_cents: -111, category_id: CATEGORY.impostos, credit_card_id: CARD.inter },
  { key: "inter-20260702-openrouter-1", date: "2026-07-02", description: "OpenRouter 1", amount_cents: -3163, category_id: CATEGORY.ia, credit_card_id: CARD.inter },
  { key: "inter-20260702-openrouter-2", date: "2026-07-02", description: "OpenRouter 2", amount_cents: -3163, category_id: CATEGORY.ia, credit_card_id: CARD.inter },
  { key: "inter-20260628-pague-menos", date: "2026-06-28", description: "Pague Menos 06", amount_cents: -14975, category_id: CATEGORY.saude, credit_card_id: CARD.inter, installments: { total: 4 } },
  { key: "inter-20260626-centauro", date: "2026-06-26", description: "Centauro.com.br", amount_cents: -8107, category_id: CATEGORY.roupas, credit_card_id: CARD.inter, installments: { total: 10 } },
  { key: "inter-20260726-adjust-2c", date: "2026-07-26", description: "Ajuste de fatura Inter", amount_cents: -2, category_id: CATEGORY.acertos, credit_card_id: CARD.inter },

  // Nubank, fatura 04/08.
  { key: "nubank-20260722-kaiocelular", date: "2026-07-22", description: "Kaiocelular", amount_cents: -3000, category_id: CATEGORY.duda, credit_card_id: CARD.nubank },
  { key: "nubank-20260720-posto", date: "2026-07-20", description: "Posto Sao Goncalo", amount_cents: -3000, category_id: CATEGORY.transporte, credit_card_id: CARD.nubank },
  { key: "nubank-20260718-vivo", date: "2026-07-18", description: "Conta Vivo", amount_cents: -4700, category_id: CATEGORY.dudaMeu, credit_card_id: CARD.nubank },
  { key: "nubank-20260717-amazon-refund", date: "2026-07-17", description: "Estorno Amazon BR VII - NuPay", amount_cents: 2639, category_id: CATEGORY.acertos, credit_card_id: CARD.nubank },
  { key: "nubank-20260717-rede-jg", date: "2026-07-17", description: "Rede JG Avenida Comercio", amount_cents: -2500, category_id: CATEGORY.duda, credit_card_id: CARD.nubank },
  { key: "nubank-20260712-rede-jg", date: "2026-07-12", description: "Rede JG Avenida Comercio", amount_cents: -2500, category_id: CATEGORY.duda, credit_card_id: CARD.nubank },
  { key: "nubank-20260711-dlknet", date: "2026-07-11", description: "Dlknet AC Esplanada", amount_cents: -9099, category_id: CATEGORY.duda, credit_card_id: CARD.nubank },
  { key: "nubank-20260705-acai", date: "2026-07-05", description: "Acaiteria Imperial", amount_cents: -1476, category_id: CATEGORY.lanches, credit_card_id: CARD.nubank },
  { key: "nubank-20260704-trailer", date: "2026-07-04", description: "MP Trailer do Mano", amount_cents: -2346, category_id: CATEGORY.alimentacao, credit_card_id: CARD.nubank },
  { key: "nubank-20260703-ifd-jean", date: "2026-07-03", description: "IFD Jean Lama", amount_cents: -3383, category_id: CATEGORY.lanches, credit_card_id: CARD.nubank },
  { key: "nubank-20260703-99", date: "2026-07-03", description: "99app", amount_cents: -2510, category_id: CATEGORY.transporte, credit_card_id: CARD.nubank },
  { key: "nubank-20260703-ifd-contorno", date: "2026-07-03", description: "IFD Contorno Alimentos", amount_cents: -3499, category_id: CATEGORY.lanches, credit_card_id: CARD.nubank },
  { key: "nubank-20260703-castelo", date: "2026-07-03", description: "Castelo das Utilidades", amount_cents: -300, category_id: CATEGORY.casa, credit_card_id: CARD.nubank },
  { key: "nubank-20260701-amazon", date: "2026-07-01", description: "Amazon BR VII - NuPay", amount_cents: -2639, category_id: CATEGORY.compras, credit_card_id: CARD.nubank },
  { key: "nubank-20260630-99", date: "2026-06-30", description: "99app", amount_cents: -2560, category_id: CATEGORY.transporte, credit_card_id: CARD.nubank },
  { key: "nubank-20260627-apple", date: "2026-06-27", description: "Apple.com/bill", amount_cents: -3290, category_id: CATEGORY.assinaturas, credit_card_id: CARD.nubank },
  { key: "nubank-20260626-mercadolivre", date: "2026-06-26", description: "MercadoLivre - parcela 2/2", amount_cents: -2863, category_id: CATEGORY.duda, credit_card_id: CARD.nubank },
  { key: "nubank-20260626-celularcia", date: "2026-06-26", description: "Celularcia - parcela 2/2", amount_cents: -8500, category_id: CATEGORY.lazer, credit_card_id: CARD.nubank },
  { key: "nubank-20260727-adjust-1c", date: "2026-07-27", description: "Ajuste de fatura Nubank", amount_cents: 1, category_id: CATEGORY.acertos, credit_card_id: CARD.nubank },

  // Amazon/Bradescard, fatura 28/07.
  { key: "amazon-20260617-5136", date: "2026-06-17", description: "Amazon BR", amount_cents: -5136, category_id: CATEGORY.compras, credit_card_id: CARD.amazon, installments: { total: 3 } },
  { key: "amazon-20260706-3359", date: "2026-07-06", description: "Amazon BR", amount_cents: -3359, category_id: CATEGORY.compras, credit_card_id: CARD.amazon, installments: { total: 4 } },
  { key: "amazon-20260707-1127", date: "2026-07-07", description: "Amazon BR", amount_cents: -1127, category_id: CATEGORY.compras, credit_card_id: CARD.amazon, installments: { total: 4 } },
  { key: "amazon-20260709-3780", date: "2026-07-09", description: "Amazon BR", amount_cents: -3780, category_id: CATEGORY.compras, credit_card_id: CARD.amazon },

  // Mercado Pago, fatura 20/07.
  { key: "mpcard-20260616-napoleon", date: "2026-06-16", description: "EC Napoleon", amount_cents: -6499, category_id: CATEGORY.assinaturas, credit_card_id: CARD.mercadoPago },
  { key: "mpcard-20260616-magazinemds", date: "2026-06-16", description: "MercadoLivre MagazineMDS", amount_cents: -3900, category_id: CATEGORY.compras, credit_card_id: CARD.mercadoPago },
  { key: "mpcard-20260709-iflores", date: "2026-07-09", description: "EC iFlores", amount_cents: -100, category_id: CATEGORY.presentes, credit_card_id: CARD.mercadoPago },

  // Ajustes tecnicos das faturas pagas, fora do relatorio de gastos.
  { key: "picpay-invoice-318-adjust", date: "2026-06-28", description: "Ajuste de conciliacao fatura PicPay", amount_cents: -26606, category_id: CATEGORY.acertos, credit_card_id: CARD.picpay },
  { key: "inter-invoice-318-adjust", date: "2026-06-26", description: "Ajuste de conciliacao fatura Inter", amount_cents: 7786, category_id: CATEGORY.acertos, credit_card_id: CARD.inter },
  { key: "nubank-invoice-318-adjust", date: "2026-06-27", description: "Ajuste de conciliacao fatura Nubank", amount_cents: 6393, category_id: CATEGORY.acertos, credit_card_id: CARD.nubank, notes: "Complementa a correcao do Celularcia de 170,00 para 85,00; ajuste total da fatura anterior: 148,93." }
];

const accountTransactions: TxInput[] = [
  // Caixa, junho.
  { key: "caixa-20260624-thiane", date: "2026-06-24", description: "Pix recebido Thiane Santos", amount_cents: 2000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260625-aruana", date: "2026-06-25", description: "Aruana Garden", amount_cents: -162951, category_id: CATEGORY.casa, account_id: ACCOUNT.caixa },
  { key: "caixa-20260627-pj", date: "2026-06-27", description: "Transferencia recebida conta PJ", amount_cents: 358971, category_id: CATEGORY.transferencias, account_id: ACCOUNT.caixa },
  { key: "caixa-20260627-cinemark", date: "2026-06-27", description: "Cinemark Aracaju", amount_cents: -9900, category_id: CATEGORY.lazer, account_id: ACCOUNT.caixa },
  { key: "caixa-20260627-aracaju", date: "2026-06-27", description: "Aracaju Administra", amount_cents: -550, category_id: CATEGORY.lazer, account_id: ACCOUNT.caixa },
  { key: "caixa-20260627-riomar", date: "2026-06-27", description: "Riomar Aracaju", amount_cents: -550, category_id: CATEGORY.lazer, account_id: ACCOUNT.caixa },
  { key: "caixa-20260630-vinicius", date: "2026-06-30", description: "Pix recebido Vinicius Bispo", amount_cents: 4760, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260630-igua", date: "2026-06-30", description: "Igua Sergipe", amount_cents: -10345, category_id: CATEGORY.assinaturas, account_id: ACCOUNT.caixa },

  // Caixa, julho. Pagamentos de cartao entram pelo endpoint de faturas.
  { key: "caixa-20260701-prestacao", date: "2026-07-01", description: "Debito prestacao habitacional", amount_cents: -40345, category_id: CATEGORY.casa, account_id: ACCOUNT.caixa },
  { key: "caixa-20260701-claudene", date: "2026-07-01", description: "Pix recebido Claudene Almeida", amount_cents: 2900, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260702-maria", date: "2026-07-02", description: "Pix recebido Maria Eduarda", amount_cents: 68500, category_id: CATEGORY.duda, account_id: ACCOUNT.caixa },
  { key: "caixa-20260702-shpp", date: "2026-07-02", description: "SHPP Brasil", amount_cents: -2043, category_id: CATEGORY.compras, account_id: ACCOUNT.caixa },
  { key: "caixa-20260703-ruan", date: "2026-07-03", description: "Pix recebido Ruan Nikson Silva", amount_cents: 7000, category_id: CATEGORY.projetos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260703-99", date: "2026-07-03", description: "99", amount_cents: -1290, category_id: CATEGORY.transporte, account_id: ACCOUNT.caixa },
  { key: "caixa-20260703-gleidston", date: "2026-07-03", description: "Pix Gleidston Santos", amount_cents: -900, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260704-carlos-shared", date: "2026-07-04", description: "Carlos Fernando - parte compartilhada Gustavo", amount_cents: 35000, category_id: CATEGORY.receitaCompartilhada, account_id: ACCOUNT.caixa },
  { key: "caixa-20260704-carlos-personal", date: "2026-07-04", description: "Carlos Fernando - freela", amount_cents: 35000, category_id: CATEGORY.projetos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260705-transfer", date: "2026-07-05", description: "Transferencia para Mercado Pago", amount_cents: -70000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.caixa },
  { key: "caixa-20260705-anne", date: "2026-07-05", description: "Pix Anne Nicole Vasconcelos", amount_cents: -1000, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260706-cledinea", date: "2026-07-06", description: "Pix recebido Cledinea Santos", amount_cents: 200000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260706-maria", date: "2026-07-06", description: "Pix recebido Maria Eduarda", amount_cents: 9200, category_id: CATEGORY.duda, account_id: ACCOUNT.caixa },
  { key: "caixa-20260706-cesta", date: "2026-07-06", description: "Mensalidade cesta servico", amount_cents: -1600, category_id: CATEGORY.impostos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260707-transfer-105", date: "2026-07-07", description: "Transferencia recebida Mercado Pago", amount_cents: 10500, category_id: CATEGORY.transferencias, account_id: ACCOUNT.caixa },
  { key: "caixa-20260707-transfer-pj", date: "2026-07-07", description: "Transferencia recebida conta PJ", amount_cents: 45000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.caixa },
  { key: "caixa-20260707-aruana", date: "2026-07-07", description: "Entrada financiamento apartamento - Aruana Garden", amount_cents: -317409, category_id: 153784132, account_id: ACCOUNT.caixa },
  { key: "caixa-20260707-jario", date: "2026-07-07", description: "Pix Jario de Santana", amount_cents: -200, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260707-fabrici", date: "2026-07-07", description: "Compra debito Fabrici", amount_cents: -1000, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260708-carlos", date: "2026-07-08", description: "Pix recebido Carlos Fernando - freela compartilhado", amount_cents: 50000, category_id: CATEGORY.receitaCompartilhada, account_id: ACCOUNT.caixa },
  { key: "caixa-20260708-condominio", date: "2026-07-08", description: "Inadimplencia Zero - condominio", amount_cents: -39847, category_id: CATEGORY.casa, account_id: ACCOUNT.caixa },
  { key: "caixa-20260709-will", date: "2026-07-09", description: "Will Financeira", amount_cents: -17242, category_id: CATEGORY.compras, account_id: ACCOUNT.caixa },
  { key: "caixa-20260710-valner", date: "2026-07-10", description: "Pix Valner Alves Santos", amount_cents: -900, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260710-rueslei-in", date: "2026-07-10", description: "Pix recebido Rueslei Conceicao - estornado", amount_cents: 65000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260710-rueslei-out", date: "2026-07-10", description: "Pix devolvido Rueslei Conceicao", amount_cents: -65000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260710-denise", date: "2026-07-10", description: "Denise Figueredo", amount_cents: -22000, category_id: CATEGORY.bares, account_id: ACCOUNT.caixa },
  { key: "caixa-20260713-rpc-personal", date: "2026-07-13", description: "RPC Negocios Digitais - parte pessoal", amount_cents: 50850, category_id: CATEGORY.projetos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260713-rpc-shared", date: "2026-07-13", description: "RPC Negocios Digitais - parte Gustavo", amount_cents: 36250, category_id: CATEGORY.receitaCompartilhada, account_id: ACCOUNT.caixa },
  { key: "caixa-20260713-transfer", date: "2026-07-13", description: "Transferencia para Mercado Pago", amount_cents: -50300, category_id: CATEGORY.transferencias, account_id: ACCOUNT.caixa },
  { key: "caixa-20260713-metalurgica", date: "2026-07-13", description: "Metalurgica Primar", amount_cents: -200, category_id: CATEGORY.outros, account_id: ACCOUNT.caixa },
  { key: "caixa-20260713-sbf", date: "2026-07-13", description: "SBF Comercio", amount_cents: -11472, category_id: CATEGORY.roupas, account_id: ACCOUNT.caixa },
  { key: "caixa-20260715-strada", date: "2026-07-15", description: "Strada Auto Center", amount_cents: -30000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260715-deposito", date: "2026-07-15", description: "Deposito dinheiro loterico", amount_cents: 13847, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260715-rueslei", date: "2026-07-15", description: "Pix recebido Rueslei Conceicao", amount_cents: 1500, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260715-tim", date: "2026-07-15", description: "Recarga TIM", amount_cents: -1500, category_id: CATEGORY.presentes, account_id: ACCOUNT.caixa },
  { key: "caixa-20260716-gustavo-out", date: "2026-07-16", description: "Pix Gustavo Mendonca", amount_cents: -30000, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260716-gustavo-in", date: "2026-07-16", description: "Pix recebido Gustavo Mendonca", amount_cents: 5200, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260716-alysson", date: "2026-07-16", description: "Pix Alysson Victor", amount_cents: -1300, category_id: CATEGORY.lazer, account_id: ACCOUNT.caixa },
  { key: "caixa-20260717-99", date: "2026-07-17", description: "99", amount_cents: -564, category_id: CATEGORY.transporte, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-99", date: "2026-07-20", description: "99", amount_cents: -1305, category_id: CATEGORY.transporte, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-rpc-personal", date: "2026-07-20", description: "RPC Negocios Digitais - parte pessoal", amount_cents: 42500, category_id: CATEGORY.projetos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-rpc-shared", date: "2026-07-20", description: "RPC Negocios Digitais - parte Gustavo", amount_cents: 42500, category_id: CATEGORY.receitaCompartilhada, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-energisa", date: "2026-07-20", description: "Energisa Sergipe", amount_cents: -35778, category_id: CATEGORY.assinaturas, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-gustavo", date: "2026-07-20", description: "Pix Gustavo Mendonca", amount_cents: -13400, category_id: CATEGORY.acertos, account_id: ACCOUNT.caixa },
  { key: "caixa-20260720-surf", date: "2026-07-20", description: "Surf Telecom", amount_cents: -3600, category_id: CATEGORY.assinaturas, account_id: ACCOUNT.caixa },
  { key: "caixa-20260722-alysson", date: "2026-07-22", description: "Pix Alysson Victor", amount_cents: -1700, category_id: CATEGORY.lazer, account_id: ACCOUNT.caixa },
  { key: "caixa-20260723-maria", date: "2026-07-23", description: "Pix Maria Eduarda", amount_cents: -1000, category_id: CATEGORY.dudaMeu, account_id: ACCOUNT.caixa },
  { key: "caixa-20260724-99", date: "2026-07-24", description: "99", amount_cents: -520, category_id: CATEGORY.transporte, account_id: ACCOUNT.caixa },
  { key: "caixa-20260725-cartao-caixa", date: "2026-07-25", description: "Cartoes Caixa Visa", amount_cents: -1750, category_id: CATEGORY.impostos, account_id: ACCOUNT.caixa, notes: "Valor definido pelo usuario; extrato mostra 17,25." },

  // PicPay conta.
  { key: "picpay-account-20260625-energisa", date: "2026-06-25", description: "Energisa Sergipe", amount_cents: -32180, category_id: CATEGORY.assinaturas, account_id: ACCOUNT.picpay },
  { key: "picpay-account-20260626-salario", date: "2026-06-26", description: "TED recebido - salario Detran", amount_cents: 127693, category_id: CATEGORY.salario, account_id: ACCOUNT.picpay },
  { key: "picpay-account-20260626-transfer", date: "2026-06-26", description: "Transferencia para Mercado Pago", amount_cents: -135896, category_id: CATEGORY.transferencias, account_id: ACCOUNT.picpay },

  // Mercado Pago conta, junho e julho.
  { key: "mp-account-20260617-hs-in", date: "2026-06-17", description: "HS do Brasil - entrada", amount_cents: 30000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260617-hs-50a", date: "2026-06-17", description: "HS do Brasil", amount_cents: -5000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260617-hs-100a", date: "2026-06-17", description: "HS do Brasil", amount_cents: -10000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260617-hs-50b", date: "2026-06-17", description: "HS do Brasil", amount_cents: -5000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260617-hs-100b", date: "2026-06-17", description: "HS do Brasil", amount_cents: -10000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260626-transfer-in", date: "2026-06-26", description: "Transferencia recebida PicPay", amount_cents: 135896, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260626-balao", date: "2026-06-26", description: "Reserva Balao ap", amount_cents: -135992, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260629-balao", date: "2026-06-29", description: "Dinheiro retirado Balao ap", amount_cents: 2000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260629-deiverson", date: "2026-06-29", description: "Pix Deiverson Vieira", amount_cents: -2000, category_id: CATEGORY.outros, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260630-rueslei", date: "2026-06-30", description: "Pix recebido Rueslei Conceicao", amount_cents: 4760, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260630-iflores", date: "2026-06-30", description: "iFlores", amount_cents: -100, category_id: CATEGORY.presentes, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260701-yield", date: "2026-07-01", description: "Rendimento Mercado Pago", amount_cents: 2, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260702-yield", date: "2026-07-02", description: "Rendimento Mercado Pago", amount_cents: 2, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260702-lynne", date: "2026-07-02", description: "Pix Lynne Menezes Gurgel", amount_cents: -2500, category_id: CATEGORY.outros, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260702-google", date: "2026-07-02", description: "Google Brasil Pagamentos", amount_cents: -799, category_id: CATEGORY.assinaturas, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260703-yield", date: "2026-07-03", description: "Rendimento Mercado Pago", amount_cents: 1, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260705-transfer-in", date: "2026-07-05", description: "Transferencia recebida Caixa", amount_cents: 70000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260705-balao", date: "2026-07-05", description: "Dinheiro retirado Balao ap", amount_cents: 30000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260705-cledinea", date: "2026-07-05", description: "Pix Cledinea Santos", amount_cents: -100000, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260706-yield", date: "2026-07-06", description: "Rendimento Mercado Pago", amount_cents: 1, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260707-yield", date: "2026-07-07", description: "Rendimento Mercado Pago", amount_cents: 1, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260707-balao", date: "2026-07-07", description: "Dinheiro retirado Balao ap", amount_cents: 9144, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260707-transfer", date: "2026-07-07", description: "Transferencia para Caixa", amount_cents: -10512, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago, notes: "Diferenca bancaria de 0,12 em relacao a entrada na Caixa." },
  { key: "mp-account-20260713-transfer-in", date: "2026-07-13", description: "Transferencia recebida Caixa", amount_cents: 50300, category_id: CATEGORY.transferencias, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260717-refund", date: "2026-07-17", description: "Reembolso Compra Garantida", amount_cents: 4099, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260719-mercadolivre", date: "2026-07-19", description: "Mercado Livre", amount_cents: -4003, category_id: CATEGORY.compras, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260720-yield", date: "2026-07-20", description: "Rendimento Mercado Pago", amount_cents: 2, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },
  { key: "mp-account-20260724-refund", date: "2026-07-24", description: "Reembolso Mercado Livre", amount_cents: 6968, category_id: CATEGORY.acertos, account_id: ACCOUNT.mercadoPago },

  // Conta PJ/PicPay Empresas.
  { key: "pj-20260625-cofrinho", date: "2026-06-25", description: "Resgate do cofrinho", amount_cents: 151210, category_id: CATEGORY.transferencias, account_id: ACCOUNT.pj },
  { key: "pj-20260627-transfer", date: "2026-06-27", description: "Transferencia para Caixa", amount_cents: -358971, category_id: CATEGORY.transferencias, account_id: ACCOUNT.pj },
  { key: "pj-20260706-joao", date: "2026-07-06", description: "Joao Paulo - projeto Wordpress", amount_cents: 45000, category_id: CATEGORY.wordpress, account_id: ACCOUNT.pj },
  { key: "pj-20260707-transfer", date: "2026-07-07", description: "Transferencia para Caixa", amount_cents: -45000, category_id: CATEGORY.transferencias, account_id: ACCOUNT.pj },
  { key: "pj-20260713-ryan", date: "2026-07-13", description: "Ryan Dias Ferreira - projeto", amount_cents: 100000, category_id: CATEGORY.projetos, account_id: ACCOUNT.pj },
  { key: "pj-20260714-keylane", date: "2026-07-14", description: "Pix Keylane Kelly Ferreira Silva", amount_cents: -600, category_id: CATEGORY.outros, account_id: ACCOUNT.pj },
  { key: "pj-20260715-ryan", date: "2026-07-15", description: "Ryan Dias Ferreira - acerto de emprestimo", amount_cents: 30000, category_id: CATEGORY.acertos, account_id: ACCOUNT.pj },
  { key: "pj-20260722-giovani", date: "2026-07-22", description: "Giovani de Gois Lima - parte pessoal", amount_cents: 13000, category_id: CATEGORY.projetos, account_id: ACCOUNT.pj },
  { key: "pj-20260722-giovani-shared", date: "2026-07-22", description: "Giovani de Gois Lima - parte compartilhada", amount_cents: 17000, category_id: CATEGORY.receitaCompartilhada, account_id: ACCOUNT.pj },
  { key: "pj-20260723-gustavo", date: "2026-07-23", description: "Pix Gustavo Mendonca", amount_cents: -15000, category_id: CATEGORY.acertos, account_id: ACCOUNT.pj },
  { key: "pj-20260724-ryan-1500", date: "2026-07-24", description: "Ryan Dias Ferreira - projeto", amount_cents: 150000, category_id: CATEGORY.projetos, account_id: ACCOUNT.pj },
  { key: "pj-20260724-ryan-1000", date: "2026-07-24", description: "Ryan Dias Ferreira - projeto", amount_cents: 100000, category_id: CATEGORY.projetos, account_id: ACCOUNT.pj },
  { key: "pj-20260725-faculdade-cooperar", date: "2026-07-25", description: "Faculdade Cooperar - projeto", amount_cents: 50000, category_id: CATEGORY.projetos, account_id: ACCOUNT.pj },
  { key: "pj-20260724-nic", date: "2026-07-24", description: "NIC.br - dominio", amount_cents: -4000, category_id: CATEGORY.acertos, account_id: ACCOUNT.pj },
  { key: "pj-20260724-boleto", date: "2026-07-24", description: "Pagamento de boleto - Saldo", amount_cents: -4000, category_id: CATEGORY.outros, account_id: ACCOUNT.pj },
  { key: "pj-opening-adjustment", date: "2026-06-25", description: "Ajuste de saldo inicial conta PJ", amount_cents: -237039, category_id: CATEGORY.acertos, account_id: ACCOUNT.pj, notes: "Ajuste para alinhar saldo inicial do Organizze ao extrato PicPay Empresas." }
];

// Correcoes de valores existentes e remocao dos extras que nao constam nas faturas.
await updateTransaction(3205485475, { amount_cents: -8500, description: "Celularcia - parcela 1/2", category_id: CATEGORY.lazer }, "Celularcia primeira parcela");
await updateTransaction(3205456473, { amount_cents: -92233 }, "Confiauto 2/6");
await updateTransaction(3187878620, { amount_cents: -11166, update_future: true }, "SOS Motos 3/6 e futuras");
await updateTransaction(3205430923, { amount_cents: -5999, update_future: true }, "Mulvi 2/5 e futuras");
await updateTransaction(3205431072, { amount_cents: -5064, update_future: true }, "MercadoLivre 2/4 e futuras");
await updateTransaction(3199670461, { amount_cents: -3611, update_future: true }, "Shein 2/4 e futuras");
await updateTransaction(3199670471, { amount_cents: -3354, update_future: true }, "Shein 2/6 e futuras");
await updateTransaction(3199670477, { amount_cents: -6133, update_future: true }, "Salao 2/3 e futuras");

await deleteTransaction(3187878641, "Google Claude extra da fatura Inter 02/08");
await deleteTransaction(3188926773, "GitHub extra da fatura Inter 02/08");

const netflix = existing.find((transaction) =>
  transaction.credit_card_id === CARD.picpay &&
  transaction.credit_card_invoice_id === 319 &&
  normalize(transaction.description).includes("netflix") &&
  transaction.amount_cents === -2090
);
if (netflix) await deleteTransaction(netflix.id, "Netflix extra da fatura PicPay 05/08");

for (const transaction of cardTransactions) await ensureTransaction(transaction);
for (const transaction of accountTransactions) await ensureTransaction(transaction);

// Pagamentos bancarios comprovados nos extratos.
await ensureInvoicePayment(CARD.inter, 318, ACCOUNT.caixa, 138577, "2026-06-30", "Pagamento fatura Inter");
await ensureInvoicePayment(CARD.nubank, 318, ACCOUNT.caixa, 116282, "2026-06-30", "Pagamento fatura Nubank");
await ensureInvoicePayment(CARD.picpay, 318, ACCOUNT.caixa, 318796, "2026-07-04", "Pagamento fatura PicPay");
await ensureInvoicePayment(CARD.mercadoPago, 318, ACCOUNT.mercadoPago, 50288, "2026-07-13", "Pagamento fatura Mercado Pago");
await ensureInvoicePayment(CARD.amazon, 318, ACCOUNT.caixa, 24576, "2026-07-20", "Pagamento fatura Amazon");

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  created: created.length,
  updated: updated.length,
  removed: removed.length,
  payments: payments.length,
  skipped: skipped.length,
  created_items: created,
  updated_items: updated,
  removed_items: removed,
  payment_items: payments
}, null, 2));
