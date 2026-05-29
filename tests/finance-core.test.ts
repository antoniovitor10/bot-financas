import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { TextParser } from "../src/parsers/text-parser.js";
import { MultiTextParser, amountLooksPresent, countAmounts } from "../src/parsers/multi-text-parser.js";
import { LoanParser } from "../src/parsers/loan-parser.js";
import { NubankPdfParser } from "../src/parsers/nubank-pdf-parser.js";
import { PicPayPdfParser } from "../src/parsers/picpay-pdf-parser.js";
import { AliasesRepo } from "../src/repositories/aliases-repo.js";
import { LearningRepo } from "../src/repositories/learning-repo.js";
import { Categorizer } from "../src/services/categorizer.js";
import { dueKeyboard, renderDueItems, type DueItem } from "../src/services/due-review.js";
import type { ParsedTransaction } from "../src/types/finance.js";
import { todayIso } from "../src/utils/dates.js";

function setupCategorizer() {
  const db = new Database(":memory:");
  const aliases = new AliasesRepo(db);
  const learning = new LearningRepo(db);
  aliases.migrate();
  learning.migrate();
  aliases.syncCatalog({
    accounts: [
      { id: 10, name: "caixa" },
      { id: 11, name: "Pagamento de contas" }
    ],
    categories: [
      { id: 100, name: "Mercado" },
      { id: 101, name: "Lanches" },
      { id: 102, name: "Emprestimos" },
      { id: 103, name: "Assinaturas e servicos" }
    ],
    creditCards: [
      { id: 20, name: "nu bank" },
      { id: 21, name: "mercado pago" },
      { id: 22, name: "PicPay" }
    ]
  });

  return {
    aliases,
    learning,
    categorizer: new Categorizer(aliases, {}, learning)
  };
}

describe("texto e audio", () => {
  test("usa a data de hoje quando o texto nao informa data", () => {
    const parsed = new TextParser().parse("gastei 42,90 no mercado no nubank categoria mercado");

    assert.equal(parsed.date, todayIso());
    assert.equal(parsed.amount_cents, -4290);
    assert.equal(parsed.description, "mercado");
    assert.equal(parsed.paid, true);
  });

  test("nao transforma 4,25 em 425,00 no split de audio com varias transacoes", () => {
    const transcript = "Sushi R$ 24,00 na categoria lanches no cartao de credito PicPay. Cafe R$ 4,25 lanches na conta caixa.";
    const parsed = new MultiTextParser(new TextParser()).parse(transcript, "voice");

    assert.equal(countAmounts(transcript), 2);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].amount_cents, -2400);
    assert.equal(parsed[1].amount_cents, -425);
    assert.equal(amountLooksPresent(transcript, parsed[1].amount_cents), true);
  });

  test("emprestei gera saida paga e conta a receber futura", () => {
    const bundle = new LoanParser().parse("emprestei 100 para minha avo hoje e ela vai me pagar dia 20", "text");

    assert.ok(bundle);
    assert.equal(bundle.transactions.length, 2);
    assert.equal(bundle.transactions[0].type, "expense");
    assert.equal(bundle.transactions[0].amount_cents, -10000);
    assert.equal(bundle.transactions[0].paid, true);
    assert.equal(bundle.transactions[1].type, "income");
    assert.equal(bundle.transactions[1].amount_cents, 10000);
    assert.equal(bundle.transactions[1].paid, false);
    assert.match(bundle.transactions[1].description || "", /Receber emprestimo/i);
  });
});

describe("categorizacao e aprendizado", () => {
  test("cartao explicito nubank vence sobre nome de compra mercado", () => {
    const { categorizer } = setupCategorizer();
    const parsed = new TextParser().parse("gastei 42,90 no mercado hoje no nubank categoria mercado");
    const enriched = categorizer.enrich(parsed);

    assert.equal(enriched.description, "mercado");
    assert.equal(enriched.credit_card_id, 20);
    assert.equal(enriched.credit_card_name, "nu bank");
    assert.equal(enriched.account_id, undefined);
    assert.equal(enriched.category_id, 100);
    assert.equal(enriched.category_name, "Mercado");
    assert.deepEqual(enriched.missing_fields, []);
  });

  test("aprendizado aplica categoria na primeira vez e destino so apos repeticao", () => {
    const { categorizer, learning } = setupCategorizer();
    const learned: ParsedTransaction = {
      type: "expense",
      description: "Cafe",
      amount_cents: -425,
      date: todayIso(),
      category_id: 101,
      category_name: "Lanches",
      credit_card_id: 22,
      credit_card_name: "PicPay",
      confidence: 0.95,
      missing_fields: [],
      source: "text"
    };

    learning.learn(learned);
    const first = categorizer.enrich({
      type: "expense",
      description: "cafe",
      amount_cents: -500,
      date: todayIso(),
      confidence: 0.6,
      missing_fields: [],
      source: "text"
    });

    assert.equal(first.category_id, 101);
    assert.equal(first.category_name, "Lanches");
    assert.equal(first.credit_card_id, undefined);
    assert.deepEqual(first.missing_fields, ["account_id_or_credit_card_id"]);

    learning.learn(learned);
    const second = categorizer.enrich({
      type: "expense",
      description: "cafe",
      amount_cents: -500,
      date: todayIso(),
      confidence: 0.6,
      missing_fields: [],
      source: "text"
    });

    assert.equal(second.category_id, 101);
    assert.equal(second.credit_card_id, 22);
    assert.equal(second.credit_card_name, "PicPay");
    assert.deepEqual(second.missing_fields, []);
  });
});

describe("fixo e parcelado", () => {
  test("despesa fixa vira recorrencia mensal sem parcelamento", () => {
    const { categorizer } = setupCategorizer();
    const parsed = new TextParser().parse("paguei netflix 20,90 fixo no picpay categoria assinaturas");
    const enriched = categorizer.enrich(parsed);

    assert.equal(enriched.description, "netflix");
    assert.equal(enriched.amount_cents, -2090);
    assert.deepEqual(enriched.recurrence, { periodicity: "monthly" });
    assert.equal(enriched.installments, undefined);
    assert.equal(enriched.credit_card_id, 22);
    assert.equal(enriched.category_id, 103);
    assert.deepEqual(enriched.missing_fields, []);
  });

  test("compra parcelada preserva total de parcelas e nao vira recorrencia fixa", () => {
    const { categorizer } = setupCategorizer();
    const parsed = new TextParser().parse("comprei cadeira 300 parcelado em 3 vezes no nubank categoria mercado");
    const enriched = categorizer.enrich(parsed);

    assert.equal(enriched.description, "cadeira");
    assert.equal(enriched.amount_cents, -30000);
    assert.deepEqual(enriched.installments, { periodicity: "monthly", total: 3 });
    assert.equal(enriched.recurrence, undefined);
    assert.equal(enriched.credit_card_id, 20);
    assert.equal(enriched.category_id, 100);
    assert.deepEqual(enriched.missing_fields, []);
  });
});

describe("pdfs de cartao", () => {
  test("PicPay extrai itens e parcelamento", () => {
    const text = [
      "PicPay Mastercard",
      "Vencimento 20/05/2026",
      "16-04-2026 | 15-05-2026",
      "Total geral dos lancamentos",
      "Picpay Card final 1234",
      "Transacoes Nacionais",
      "26/04 NOSSO MERKADO 39,26",
      "27/04 NETFLIX.COM 20,90",
      "28/04 MP *TRAILERDOMANO PARC 01/03 25,00",
      "Valores em R$"
    ].join("\n");

    const parsed = new PicPayPdfParser().parse(text);

    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].description, "NOSSO MERKADO");
    assert.equal(parsed[0].amount_cents, -3926);
    assert.equal(parsed[0].date, "2026-04-26");
    assert.equal(parsed[2].installments?.current, 1);
    assert.equal(parsed[2].installments?.total, 3);
  });

  test("Nubank ignora pagamento e preserva parcelas", () => {
    const text = [
      "Nubank",
      "FATURA 03 MAI 2026",
      "Data de vencimento: 03 MAI 2026",
      "TRANSACOES DE ANTONIO",
      "26 ABR",
      "MERCADO R$ 42,90",
      "27 ABR LOJA Parcela 1/3 R$ 100,00",
      "Pagamentos",
      "Pagamento recebido R$ 50,00",
      "Total a pagar R$ 142,90"
    ].join("\n");

    const parsed = new NubankPdfParser().parse(text);

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].description, "MERCADO");
    assert.equal(parsed[0].amount_cents, -4290);
    assert.equal(parsed[0].date, "2026-04-26");
    assert.equal(parsed[1].installments?.current, 1);
    assert.equal(parsed[1].installments?.total, 3);
  });
});

describe("vencimentos", () => {
  test("vencimentos mostram fatura agregada e botao de pagar so para conta", () => {
    const items: DueItem[] = [
      {
        kind: "transaction",
        transaction: {
          id: 1,
          description: "boleto energia",
          date: "2026-05-20",
          paid: false,
          amount_cents: -12000,
          total_installments: 1,
          installment: 1,
          recurring: false,
          account_id: 10,
          category_id: 100
        }
      },
      {
        kind: "invoice",
        cardName: "mercado pago",
        invoice: {
          id: 316,
          date: "2026-05-20",
          starting_date: "2026-04-16",
          closing_date: "2026-05-15",
          amount_cents: -32175,
          payment_amount_cents: 0,
          balance_cents: -32175,
          previous_balance_cents: 0,
          credit_card_id: 21,
          transactions: []
        }
      }
    ];

    const text = renderDueItems("Contas do mes", items);
    const keyboard = dueKeyboard(items) as unknown as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };

    assert.match(text, /boleto energia/);
    assert.match(text, /fatura mercado pago/);
    assert.equal(keyboard.reply_markup.inline_keyboard.length, 1);
    assert.equal(keyboard.reply_markup.inline_keyboard[0][0].callback_data, "pay:1");
  });
});
