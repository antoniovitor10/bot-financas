import { config } from "../src/config.js";

const baseUrl = config.organizze.baseUrl.replace(/\/$/, "");
const auth = `Basic ${Buffer.from(`${config.organizze.email}:${config.organizze.token}`).toString("base64")}`;

async function request<T = void>(path: string, init: RequestInit = {}): Promise<T | undefined> {
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
  if (response.status === 404) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T | undefined;
}

await request("/transactions/3187932169", { method: "DELETE" });
await request("/transactions/3187936303", { method: "DELETE" });
await request("/transactions/3187936304", {
  method: "PUT",
  body: JSON.stringify({ amount_cents: -1750, update_future: true })
});
await request("/transactions/3187937506", { method: "DELETE" });

for (const transactionId of [3202190014, 3202190015, 3202190016]) {
  await request(`/transactions/${transactionId}`, { method: "DELETE" });
}

for (const transactionId of [
  3187936083,
  3187930841,
  3187930986,
  3187938662,
  3187930128,
  3187932665
]) {
  await request(`/transactions/${transactionId}`, {
    method: "PUT",
    body: JSON.stringify({ paid: true })
  });
}
await request("/transactions/3187929803", { method: "DELETE" });

for (const transactionId of [3205430515, 3205430520, 3205430523]) {
  await request(`/transactions/${transactionId}`, { method: "DELETE" });
}

await request("/transactions/3221402376", {
  method: "PUT",
  body: JSON.stringify({
    amount_cents: 100974,
    description: "Ajuste tecnico de saldo Caixa",
    category_id: 164258344,
    paid: true
  })
});
await request("/transactions/3221400275", {
  method: "PUT",
  body: JSON.stringify({
    description: "Entrada financiamento apartamento - Aruana Garden",
    category_id: 153784132,
    notes: "Valor real da entrada do financiamento. | reconcile-july-2026:caixa-20260707-aruana"
  })
});
await request("/transactions/3221400279", {
  method: "PUT",
  body: JSON.stringify({
    description: "Condominio - parte pessoal",
    amount_cents: -13000,
    category_id: 79404720,
    notes: "Custo pessoal: R$ 260,00 dividido por 2. Debito bancario original: R$ 398,47."
  })
});
await request("/transactions/3188927054", {
  method: "PUT",
  body: JSON.stringify({ category_id: 79404735 })
});
for (const transactionId of [3200115301, 3200876165, 3200876166, 3202189482]) {
  await request(`/transactions/${transactionId}`, {
    method: "PUT",
    body: JSON.stringify({ category_id: 79404733 })
  });
}
for (const transactionId of [3199712326, 3199712329, 3199712372]) {
  await request(`/transactions/${transactionId}`, {
    method: "PUT",
    body: JSON.stringify({ category_id: 79404732 })
  });
}

for (const [transactionId, installment] of [
  [3221400184, 1],
  [3221400185, 2],
  [3221400186, 3],
  [3221400187, 4]
]) {
  await request(`/transactions/${transactionId}`, {
    method: "PUT",
    body: JSON.stringify({
      description: `Pague Menos 06 - remedio minha vo - parcela ${installment}/4`,
      category_id: 157306754
    })
  });
}

await request("/transactions/3221400349", {
  method: "PUT",
  body: JSON.stringify({
    description: "Ryan Dias Ferreira - acerto de emprestimo",
    category_id: 164258344
  })
});
await request("/transactions/3221400350", {
  method: "PUT",
  body: JSON.stringify({
    description: "Giovani de Gois Lima - parte pessoal",
    amount_cents: 13000,
    category_id: 153864764
  })
});

const julyTransactions = await request<Array<{ notes?: string | null }>>(
  "/transactions?start_date=2026-07-01&end_date=2026-07-31"
);
if (!julyTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:condominio-parte-reembolsavel")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Condominio - parte reembolsavel/compensada",
      amount_cents: -26847,
      date: "2026-07-08",
      paid: true,
      account_id: 6272892,
      category_id: 164258344,
      notes: "Completa o debito bancario original de R$ 398,47 sem contar como gasto pessoal. | reconcile-july-2026:condominio-parte-reembolsavel"
    })
  });
}
if (!julyTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:pj-20260722-giovani-shared")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Giovani de Gois Lima - parte compartilhada",
      amount_cents: 17000,
      date: "2026-07-22",
      paid: true,
      account_id: 10025309,
      category_id: 164258372,
      notes: "reconcile-july-2026:pj-20260722-giovani-shared"
    })
  });
}

if (!julyTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:pj-20260725-faculdade-cooperar")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Faculdade Cooperar - projeto",
      amount_cents: 50000,
      date: "2026-07-25",
      paid: true,
      account_id: 10025309,
      category_id: 153864764,
      notes: "reconcile-july-2026:pj-20260725-faculdade-cooperar"
    })
  });
}

const augustTransactions = await request<Array<{ notes?: string | null }>>(
  "/transactions?start_date=2026-08-01&end_date=2026-08-31"
);
if (!augustTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:caixa-20260801-juros-obra")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Juros de obra",
      amount_cents: -49700,
      date: "2026-08-01",
      paid: false,
      account_id: 6272892,
      category_id: 153784132,
      notes: "reconcile-july-2026:caixa-20260801-juros-obra"
    })
  });
}

if (!augustTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:gustavo-reembolso-pendente-20")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Receber Gustavo - saldo de reembolso",
      amount_cents: 2000,
      date: "2026-08-10",
      paid: false,
      account_id: 6272892,
      category_id: 164714868,
      notes: "Todos os demais reembolsos de Gustavo estao quitados. | reconcile-july-2026:gustavo-reembolso-pendente-20"
    })
  });
}

const februaryTransactions = await request<Array<{ id: number; notes?: string | null }>>(
  "/transactions?start_date=2027-02-01&end_date=2027-02-28"
);
const oldFebruaryBalao = februaryTransactions?.find((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:balao-semestral-202702")
);
if (oldFebruaryBalao) {
  await request(`/transactions/${oldFebruaryBalao.id}`, {
    method: "PUT",
    body: JSON.stringify({
      description: "Balao AP - cobranca semestral",
      date: "2027-01-15",
      notes: "Cobranca semestral; anterior paga em 15/07/2026. | reconcile-july-2026:balao-semestral-202701"
    })
  });
}

const januaryTransactions = await request<Array<{ notes?: string | null }>>(
  "/transactions?start_date=2027-01-01&end_date=2027-01-31"
);
if (!oldFebruaryBalao && !januaryTransactions?.some((transaction) =>
  transaction.notes?.includes("reconcile-july-2026:balao-semestral-202701")
)) {
  await request("/transactions", {
    method: "POST",
    body: JSON.stringify({
      description: "Balao AP - cobranca semestral",
      amount_cents: -310000,
      date: "2027-01-15",
      paid: false,
      account_id: 6272892,
      category_id: 153784132,
      notes: "Cobranca semestral; anterior paga em 15/07/2026. | reconcile-july-2026:balao-semestral-202701"
    })
  });
}

console.log("Duplicatas removidas, taxa Caixa atualizada e serie incorreta da Duda excluida.");
