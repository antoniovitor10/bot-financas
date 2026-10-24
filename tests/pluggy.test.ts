import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AliasesRepo } from "../src/repositories/aliases-repo.js";
import { LearningRepo } from "../src/repositories/learning-repo.js";
import { PendingRepo } from "../src/repositories/pending-repo.js";
import { PluggyRepo } from "../src/repositories/pluggy-repo.js";
import { Categorizer } from "../src/services/categorizer.js";
import { PluggyApiService } from "../src/services/pluggy-api.js";
import { PluggySyncService, stripBankBoilerplate, toParsedTransaction } from "../src/services/pluggy-sync.js";
import type { PluggyAccount, PluggyTransaction } from "../src/types/pluggy.js";
import type { OrganizzeTransaction } from "../src/types/organizze.js";

function setup() {
  const db = new Database(":memory:");
  const aliases = new AliasesRepo(db);
  const learning = new LearningRepo(db);
  const pending = new PendingRepo(db);
  const pluggy = new PluggyRepo(db);
  aliases.migrate();
  learning.migrate();
  pending.migrate();
  pluggy.migrate();
  aliases.syncCatalog({
    accounts: [
      { id: 10, name: "Caixa" },
      { id: 11, name: "PicPay" },
      { id: 12, name: "PicPay Empresas" }
    ],
    categories: [
      { id: 100, name: "Mercado" },
      { id: 101, name: "Transporte" },
      { id: 102, name: "Assinaturas e servicos" },
      { id: 103, name: "Casa" },
      { id: 104, name: "Pagamento de fatura" },
      { id: 105, name: "Transferências" }
    ],
    creditCards: [
      { id: 20, name: "Nubank" },
      { id: 21, name: "Mercado Pago" }
    ]
  });
  return { db, aliases, learning, pending, pluggy, categorizer: new Categorizer(aliases, {}, learning) };
}

function cardTx(overrides: Partial<PluggyTransaction> = {}): PluggyTransaction {
  return {
    id: "tx-card-1",
    accountId: "acc-card",
    date: "2026-10-20T19:43:56.001Z",
    amount: 100.68,
    description: "Dlknet *Ac Esplanada",
    type: "DEBIT",
    status: "PENDING",
    category: "Services",
    createdAt: "2026-10-21T19:27:19.000Z",
    creditCardMetadata: { paymentType: "SINGLE", billPostDate: "2026-10-21" },
    ...overrides
  };
}

const cardAccount: PluggyAccount = {
  id: "acc-card",
  itemId: "item-nubank",
  type: "CREDIT",
  subtype: "CREDIT_CARD",
  name: "gold",
  balance: 1483.35,
  creditData: { brand: "MASTERCARD" }
};

const bankAccount: PluggyAccount = {
  id: "acc-bank",
  itemId: "item-caixa",
  type: "BANK",
  subtype: "CHECKING_ACCOUNT",
  name: "CAIXA",
  balance: 1498.03
};

const savingsAccount: PluggyAccount = {
  id: "acc-savings",
  itemId: "item-caixa",
  type: "BANK",
  subtype: "SAVINGS_ACCOUNT",
  name: "CAIXA",
  balance: 2.36
};

describe("pluggy: normalizacao", () => {
  const card = { type: "CREDIT", name: "gold", itemName: "Nubank" };
  const bank = { type: "BANK", name: "CAIXA", itemName: "Caixa" };
  const cardMap = { pluggy_account_id: "acc-card", kind: "credit_card" as const, target_id: 20, target_name: "Nubank", auto: true, updated_at: "" };
  const bankMap = { pluggy_account_id: "acc-bank", kind: "account" as const, target_id: 10, target_name: "Caixa", auto: true, updated_at: "" };

  test("compra no cartao (amount positivo, DEBIT) vira despesa negativa no cartao mapeado", () => {
    const parsed = toParsedTransaction(cardTx(), card, cardMap);
    assert.equal(parsed.type, "expense");
    assert.equal(parsed.amount_cents, -10068);
    assert.equal(parsed.date, "2026-10-20");
    assert.equal(parsed.credit_card_id, 20);
    assert.equal(parsed.account_id, undefined);
    assert.equal(parsed.source, "pluggy");
    assert.match(parsed.notes || "", /Pluggy tx-card-1 \| Nubank cartao \| Services \| pendente no banco/);
  });

  test("estorno no cartao (amount negativo, CREDIT) vira receita positiva", () => {
    const parsed = toParsedTransaction(cardTx({ id: "tx-estorno", amount: -24.92, type: "CREDIT", description: "Estorno de Uber - NuPay" }), card, cardMap);
    assert.equal(parsed.type, "income");
    assert.equal(parsed.amount_cents, 2492);
  });

  test("debito na conta (amount negativo, DEBIT) vira despesa e parcela vai para notas, nao para installments", () => {
    const parsed = toParsedTransaction(cardTx({
      id: "tx-bank",
      accountId: "acc-bank",
      amount: -40,
      status: "POSTED",
      description: "Pagamento com Pix NIC .BR",
      category: "Services",
      creditCardMetadata: null,
      operationType: "PIX"
    }), bank, bankMap);
    assert.equal(parsed.type, "expense");
    assert.equal(parsed.amount_cents, -4000);
    assert.equal(parsed.account_id, 10);
    assert.equal(parsed.credit_card_id, undefined);
    assert.match(parsed.notes || "", /PIX/);

    const installment = toParsedTransaction(cardTx({
      id: "tx-parc",
      description: "Mp *Autopecasprog 2/2",
      creditCardMetadata: { installmentNumber: 2, totalInstallments: 2 }
    }), card, cardMap);
    assert.equal(installment.installments, undefined);
    assert.match(installment.notes || "", /parcela 2\/2/);
    assert.match(installment.raw_text || "", /parcela 2\/2/);
  });

  test("jargao de extrato sai do texto de categorizacao, descricao fica inteira", () => {
    assert.equal(stripBankBoilerplate("Pagamento com Pix NUCLEO DE INFORMACAO E COORDENACAO"), "nucleo de informacao e coordenacao");
    assert.equal(stripBankBoilerplate("DEB PIX QR COD DIN"), "");
    assert.equal(stripBankBoilerplate("COMPRA CARTAO DEBITO SUPERMERCADO BH"), "supermercado bh");
    assert.equal(stripBankBoilerplate("Pix enviado Joao Henrique"), "joao henrique");
    assert.equal(stripBankBoilerplate("Pagamento GOOGLE BRASIL PAGAMENTOS LTDA."), "google brasil pagamentos");

    const parsed = toParsedTransaction(cardTx({ description: "Pagamento com Pix NIC .BR", creditCardMetadata: null }), bank, bankMap);
    assert.equal(parsed.description, "Pagamento com Pix NIC .BR");
    assert.ok(!/pagamento/i.test(parsed.raw_text || ""));
  });

  test("categoria da Pluggy vira dica em portugues no raw_text", () => {
    const parsed = toParsedTransaction(cardTx({ category: "Groceries", description: "Supermercado X" }), card, cardMap);
    assert.match(parsed.raw_text || "", /mercado/);
  });
});

describe("pluggy: cliente da API", () => {
  test("segue o cursor next (query string) e renova a apiKey em 401", async () => {
    const calls: string[] = [];
    let authCount = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url.replace("https://api.pluggy.ai", "")}`);
      if (url.endsWith("/auth")) {
        authCount += 1;
        return new Response(JSON.stringify({ apiKey: `key-${authCount}` }), { status: 200 });
      }
      const key = (init?.headers as Record<string, string>)["X-API-KEY"];
      if (key === "key-1") return new Response("expired", { status: 401 });
      if (url.includes("after=")) {
        return new Response(JSON.stringify({ results: [cardTx({ id: "b" }), cardTx({ id: "c" })], next: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [cardTx({ id: "a" }), cardTx({ id: "b" })], next: "?accountId=acc-card&after=cursor1" }), { status: 200 });
    }) as typeof fetch;

    const api = new PluggyApiService({ clientId: "id", clientSecret: "secret", fetchImpl });
    const transactions = await api.listTransactions("acc-card", { createdAtFrom: "2026-10-01" });

    assert.deepEqual(transactions.map((tx) => tx.id), ["a", "b", "c"]);
    assert.equal(authCount, 2);
    assert.ok(calls.some((call) => call.includes("/v2/transactions?accountId=acc-card&createdAtFrom=2026-10-01")));
    assert.ok(calls.some((call) => call.includes("/v2/transactions?accountId=acc-card&after=cursor1")));
  });
});

describe("pluggy: sincronizacao", () => {
  function fakeApi(data: { accounts: Record<string, PluggyAccount[]>; transactions: Record<string, PluggyTransaction[]> }) {
    const requests: Array<{ accountId: string; createdAtFrom?: string }> = [];
    return {
      requests,
      api: {
        async listAccounts(itemId: string) {
          return data.accounts[itemId] || [];
        },
        async listTransactions(accountId: string, params: { createdAtFrom?: string } = {}) {
          requests.push({ accountId, createdAtFrom: params.createdAtFrom });
          return data.transactions[accountId] || [];
        }
      }
    };
  }

  function makeService(ctx: ReturnType<typeof setup>, api: ReturnType<typeof fakeApi>["api"], options: { today: string; startDate?: string; existing?: OrganizzeTransaction[] }) {
    let today = options.today;
    const service = new PluggySyncService(
      {
        api,
        repo: ctx.pluggy,
        aliasesRepo: ctx.aliases,
        categorizer: ctx.categorizer,
        pendingRepo: ctx.pending,
        organizzeApi: { async listTransactions() { return options.existing || []; } }
      },
      {
        items: [{ id: "item-nubank", name: "Nubank" }, { id: "item-caixa", name: "Caixa" }],
        startDate: options.startDate || "2026-10-01",
        today: () => today
      }
    );
    return { service, setToday: (value: string) => { today = value; } };
  }

  test("mapeia contas pelo nome, respeita corte e adia parcelas futuras", async () => {
    const ctx = setup();
    const { api, requests } = fakeApi({
      accounts: { "item-nubank": [cardAccount], "item-caixa": [bankAccount, savingsAccount] },
      transactions: {
        "acc-card": [
          cardTx({ id: "nova", category: "Taxi and ride-hailing", description: "Uber" }),
          cardTx({ id: "futura", date: "2026-11-13T00:00:00.000Z", description: "Mp *Autopecasprog 2/2", creditCardMetadata: { installmentNumber: 2, totalInstallments: 2 } }),
          cardTx({ id: "antiga", date: "2026-09-10T00:00:00.000Z", description: "Compra velha" }),
          cardTx({ id: "fatura", date: "2026-10-05T00:00:00.000Z", amount: -1200, type: "CREDIT", category: "Credit card payment", description: "Pagamento recebido" })
        ],
        "acc-bank": [
          cardTx({ id: "pix", accountId: "acc-bank", amount: -40, status: "POSTED", category: "Services", description: "Pagamento com Pix NIC .BR", creditCardMetadata: null }),
          cardTx({ id: "conta", accountId: "acc-bank", amount: -17.25, status: "POSTED", category: "Bills", description: "Pagamento de conta FATURA CARTOES VISA PF", creditCardMetadata: null })
        ]
      }
    });
    const { service, setToday } = makeService(ctx, api, { today: "2026-10-24" });

    const first = await service.sync({ chatId: 1 });

    assert.equal(first.accounts, 3);
    assert.deepEqual(first.unmapped.map((account) => account.id), ["acc-savings"]);
    assert.equal(ctx.pluggy.getMap("acc-card")?.target_id, 20);
    assert.equal(ctx.pluggy.getMap("acc-bank")?.target_id, 10);
    assert.equal(first.deferred, 1);
    assert.equal(first.ignored, 1);
    assert.equal(first.candidates, 4);
    assert.ok(first.batch);

    const byId = new Map(first.batch!.candidates.map((candidate) => [candidate.pluggy_id, candidate]));
    const uber = byId.get("nova")!;
    assert.equal(uber.status, "ready");
    assert.equal(uber.transaction.credit_card_id, 20);
    assert.equal(uber.transaction.category_id, 101);
    assert.equal(uber.transaction.amount_cents, -10068);

    const fatura = byId.get("fatura")!;
    assert.equal(fatura.status, "needs_review");
    assert.match(fatura.reason || "", /Credit card payment/);

    const pix = byId.get("pix")!;
    assert.equal(pix.transaction.account_id, 10);
    assert.equal(pix.transaction.credit_card_id, undefined);
    assert.equal(pix.transaction.description, "Pagamento com Pix NIC .BR");
    assert.notEqual(pix.transaction.category_id, 104, "a palavra Pagamento nao pode puxar Pagamento de fatura");

    const conta = byId.get("conta")!;
    assert.equal(conta.status, "needs_review");
    assert.equal(conta.transaction.category_id, 104);
    assert.match(conta.reason || "", /pagamento de fatura/i);

    assert.equal(ctx.pluggy.getTransaction("nova")?.status, "batched");
    assert.equal(ctx.pluggy.getTransaction("futura")?.status, "deferred");
    assert.equal(ctx.pluggy.getTransaction("antiga")?.status, "ignored");
    assert.equal(ctx.pending.getImportBatch(first.batch!.id)?.candidates.length, 4);

    // Segunda rodada no mesmo dia: nada novo, usa createdAtFrom com sobreposicao.
    const second = await service.sync({ chatId: 1 });
    assert.equal(second.batch, undefined);
    assert.equal(second.candidates, 0);
    assert.equal(second.alreadyKnown, 6);
    assert.equal(requests.at(-1)?.createdAtFrom, "2026-10-18");

    // Quando a data da parcela futura chega, ela entra em lote sem nova chamada a API.
    setToday("2026-11-13");
    const third = await service.sync({ chatId: 1 });
    assert.equal(third.candidates, 1);
    assert.equal(third.batch?.candidates[0]?.pluggy_id, "futura");
    assert.equal(ctx.pluggy.getTransaction("futura")?.status, "batched");

    const fourth = await service.sync({ chatId: 1 });
    assert.equal(fourth.candidates, 0);
  });

  test("marca duplicado quando o backend ja tem o lancamento e respeita conta ignorada", async () => {
    const ctx = setup();
    ctx.pluggy.setMap({ pluggyAccountId: "acc-savings", kind: "ignore" });
    const { api, requests } = fakeApi({
      accounts: { "item-nubank": [cardAccount], "item-caixa": [bankAccount, savingsAccount] },
      transactions: {
        "acc-card": [
          cardTx({ id: "dup", description: "Uber", category: "Taxi and ride-hailing", amount: 24.92, date: "2026-10-18T21:04:26.051Z" }),
          cardTx({ id: "aaaaaaaa-0000-4000-8000-000000000001", description: "Netflix", category: "Streaming", amount: 55.9, date: "2026-10-19T00:00:00.000Z" })
        ],
        "acc-savings": [cardTx({ id: "poupanca", accountId: "acc-savings", amount: -1, creditCardMetadata: null })]
      }
    });
    const existing: OrganizzeTransaction[] = [{
      id: 999,
      description: "Uber",
      date: "2026-10-18",
      paid: true,
      amount_cents: -2492,
      total_installments: 1,
      installment: 1,
      recurring: false,
      account_id: 20,
      account_type: "CreditCard",
      category_id: 101,
      credit_card_id: 20
    }, {
      id: 1000,
      description: "Netflix",
      date: "2026-10-19",
      paid: true,
      amount_cents: -5590,
      total_installments: 1,
      installment: 1,
      recurring: false,
      account_id: 20,
      account_type: "CreditCard",
      category_id: 102,
      credit_card_id: 20,
      notes: "Pluggy aaaaaaaa-0000-4000-8000-000000000001 | Nubank cartao | Streaming"
    }];
    const { service } = makeService(ctx, api, { today: "2026-10-24", existing });

    const result = await service.sync({ chatId: 1 });

    assert.equal(result.unmapped.length, 0);
    assert.ok(!requests.some((request) => request.accountId === "acc-savings"));
    assert.equal(result.batch?.candidates.length, 1);
    assert.equal(result.batch?.candidates[0]?.status, "duplicate");
    assert.equal(result.batch?.candidates[0]?.matched_transaction_id, 999);
    assert.equal(result.alreadyImported, 1);
    assert.equal(ctx.pluggy.getTransaction("aaaaaaaa-0000-4000-8000-000000000001")?.status, "imported");
    assert.equal(ctx.pluggy.getTransaction("aaaaaaaa-0000-4000-8000-000000000001")?.backend_tx_id, 1000);
  });

  test("repo: marca importada e conta por status", () => {
    const ctx = setup();
    ctx.pluggy.recordTransaction({
      pluggyId: "x",
      accountId: "acc-card",
      date: "2026-10-20",
      amountCents: -100,
      description: "teste",
      status: "batched",
      pluggyStatus: "POSTED",
      payload: {},
      batchId: "lote1"
    });
    ctx.pluggy.markImported("x", 555);
    assert.equal(ctx.pluggy.getTransaction("x")?.status, "imported");
    assert.equal(ctx.pluggy.getTransaction("x")?.backend_tx_id, 555);
    assert.deepEqual(ctx.pluggy.countByStatus(), { imported: 1 });
    assert.equal(ctx.pluggy.findAccountByPrefix("acc")?.id, undefined);
  });
});
