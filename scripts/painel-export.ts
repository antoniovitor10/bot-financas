/**
 * Exporta do Organizze os dados do Painel das Financas (artifact tipo Dashboard):
 * gastos.json, receitas.json, lancamentos.json, faturas.json, vencimentos.json, nao-identificado.json.
 *
 * Uso: npx tsx scripts/painel-export.ts [pasta de saida]   (padrao: data/painel)
 * Boletos previstos ficam em PREVISTOS; os ciclos reais das faturas estao em ciclos-cartoes.ts. Os valores das faturas sao os do Organizze.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { OrganizzeApiService } from "../src/services/organizze-api.js";
import type { OrganizzeTransaction } from "../src/types/organizze.js";
import { cicloReal } from "./ciclos-cartoes.js";

const INTERNAL = new Set(["Transferências", "Pagamento de fatura", "Investimentos"]);

/** Ciclos reais das faturas (so para exibir o periodo e o vencimento real): scripts/ciclos-cartoes.ts. */

/** Boletos que se repetem todo mes e ainda nao estao lancados: descricao, valor, categoria, dia. */
const PREVISTOS: Array<[string, number, string, number]> = [
  ["Juros de obra (estimativa do Vitor)", 691.0, "financiamento AP", 1],
  ["Aluguel (boleto)", 857.5, "Casa", 9],
  ["Prestação do apartamento (boleto, estimativa do Vitor)", 1700.0, "financiamento AP", 10],
  ["Condomínio (boleto)", 398.47, "Casa", 13],
  ["DAS do MEI (boleto)", 86.05, "Impostos e Taxas", 19]
];

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
function addMonths(ym: string, k: number): string {
  const d = new Date(ym + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7);
}

export async function exportPainel(outDir: string, today = new Date().toISOString().slice(0, 10)): Promise<Record<string, number>> {
  mkdirSync(outDir, { recursive: true });
  const o = new OrganizzeApiService(config.organizze);
  const catalog = await o.getCatalog();
  const catName = new Map(catalog.categories.map((c) => [c.id, c.name.trim()]));
  const accName = new Map(catalog.accounts.map((a) => [a.id, a.name.trim()]));
  const cardName = new Map(catalog.creditCards.map((c) => [c.id, c.name.trim()]));
  const isCard = (t: OrganizzeTransaction) => t.account_type === "CreditCard" || !!t.credit_card_id;
  const where = (t: OrganizzeTransaction) => isCard(t) ? `cartão ${cardName.get(t.credit_card_id || t.account_id) || ""}` : `conta ${accName.get(t.account_id) || ""}`;

  // Janela: junho de 2026 ate 4 meses a frente (parcelas futuras).
  const start = "2026-06-01";
  const end = addMonths(today.slice(0, 7), 4) + "-28";
  const MESES = monthsBetween(start, today).filter((m) => m <= today.slice(0, 7));
  const FUTUROS = monthsBetween(addMonths(today.slice(0, 7), 1), addMonths(today.slice(0, 7), 3));

  const all: OrganizzeTransaction[] = [];
  let s = new Date(start + "T00:00:00Z"); const e = new Date(end + "T00:00:00Z");
  while (s <= e) {
    const n = new Date(s); n.setUTCDate(n.getUTCDate() + 14); const to = n > e ? e : n;
    all.push(...await o.listTransactions({ start_date: s.toISOString().slice(0, 10), end_date: to.toISOString().slice(0, 10) }));
    s = new Date(to); s.setUTCDate(s.getUTCDate() + 1);
  }
  const seen = new Set<number>(); const txs = all.filter((t) => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  // Faturas por cartao, com os ciclos corrigidos.
  type Inv = { id: number; cartao: string; cartao_id: number; vence: string; vence_real: string; inicio: string; fim: string; valor: number; pago: number; saldo: number };
  const invoices: Inv[] = [];
  for (const card of catalog.creditCards.filter((c) => !c.archived)) {
    const list = await o.listCreditCardInvoices(card.id, { start_date: start, end_date: end });
    for (const inv of list) {
      const c = cicloReal(card.name, inv.date);
      invoices.push({ id: inv.id, cartao: card.name.trim(), cartao_id: card.id, vence: inv.date, vence_real: c?.venceReal || inv.date, inicio: c?.inicio || inv.starting_date, fim: c?.fim || inv.closing_date, valor: Math.round(Math.abs(inv.amount_cents)) / 100, pago: Math.round(Math.abs(inv.payment_amount_cents)) / 100, saldo: Math.round(Math.abs(inv.balance_cents)) / 100 });
    }
  }
  // O item pertence a fatura que o Organizze diz (credit_card_invoice_id); a data e so para o caso de faltar o campo.
  const invoiceFor = (t: OrganizzeTransaction) => {
    const cid = t.credit_card_id || t.account_id;
    return invoices.find((i) => i.cartao_id === cid && i.id === t.credit_card_invoice_id) || invoices.find((i) => i.cartao_id === cid && t.date >= i.inicio && t.date <= i.fim);
  };

  // Lancamentos detalhados.
  const rows = txs.map((t) => {
    const cat = catName.get(t.category_id) || "(sem categoria)";
    const inv = isCard(t) ? invoiceFor(t) : undefined;
    const tipo = t.oposite_transaction_id ? "transferência" : INTERNAL.has(cat) ? "interna" : t.amount_cents < 0 ? "despesa" : "receita";
    return {
      id: t.id, data: t.date, mes: t.date.slice(0, 7), origem: where(t), descricao: t.description, categoria: cat,
      valor: Math.round(t.amount_cents) / 100, tipo, fatura: inv ? `${inv.cartao} ${inv.vence}` : "", fatura_vence: inv ? inv.vence : "",
      pago: t.paid ? "sim" : "não", parcela: t.total_installments > 1 ? `${t.installment}/${t.total_installments}` : ""
    };
  }).sort((a, b) => b.data.localeCompare(a.data) || Math.abs(b.valor) - Math.abs(a.valor));
  writeFileSync(join(outDir, "lancamentos.json"), JSON.stringify(rows), "utf8");

  const faturas = invoices.filter((i) => i.valor > 0 || i.vence >= addMonths(today.slice(0, 7), -1) + "-01").map((i) => {
    const itens = rows.filter((r) => r.fatura === `${i.cartao} ${i.vence}`);
    const situacao = i.saldo === 0 && i.valor > 0 ? "paga" : i.vence < today ? "vencida" : "em aberto";
    return { cartao: i.cartao, vence: i.vence, vence_real: i.vence_real, inicio: i.inicio, fim: i.fim, valor: i.valor, pago: i.pago, saldo: i.saldo, itens: itens.length, situacao };
  }).sort((a, b) => a.vence.localeCompare(b.vence) || a.cartao.localeCompare(b.cartao));
  writeFileSync(join(outDir, "faturas.json"), JSON.stringify(faturas), "utf8");

  // Gastos e receitas por categoria e mes (meses ja vividos).
  const spend: Record<string, Record<string, number>> = {}; const income: Record<string, Record<string, number>> = {};
  for (const t of txs) {
    if (t.oposite_transaction_id) continue;
    const mes = t.date.slice(0, 7); if (!MESES.includes(mes)) continue;
    const cat = catName.get(t.category_id) || "(sem categoria)"; if (INTERNAL.has(cat)) continue;
    const b = t.amount_cents < 0 ? spend : income; b[mes] = b[mes] || {}; b[mes][cat] = (b[mes][cat] || 0) + Math.abs(t.amount_cents);
  }
  const spendRows: unknown[] = []; const incomeRows: unknown[] = [];
  for (const mes of MESES) {
    for (const [categoria, c] of Object.entries(spend[mes] || {})) spendRows.push({ mes, categoria, valor: Math.round(c) / 100 });
    for (const [categoria, c] of Object.entries(income[mes] || {})) incomeRows.push({ mes, categoria, valor: Math.round(c) / 100 });
  }
  writeFileSync(join(outDir, "gastos.json"), JSON.stringify(spendRows), "utf8");
  writeFileSync(join(outDir, "receitas.json"), JSON.stringify(incomeRows), "utf8");

  // Vencimentos: faturas em aberto, contas fixas nao pagas e boletos previstos, do mes atual ate 3 meses a frente.
  const due: Array<Record<string, unknown>> = [];
  const horizonte = addMonths(today.slice(0, 7), 3) + "-31";
  for (const f of faturas) if (f.vence >= today && f.vence <= horizonte && f.saldo > 0) due.push({ data: f.vence, descricao: `Fatura ${f.cartao}`, origem: `cartão ${f.cartao}`, tipo: "fatura de cartão", valor: f.saldo, periodo: `${f.inicio} a ${f.fim}`, situacao: "em aberto" });
  for (const t of txs) {
    if (t.paid || isCard(t) || t.amount_cents >= 0 || t.date < today || t.date > horizonte) continue;
    due.push({ data: t.date, descricao: t.description, origem: where(t), tipo: t.recurring ? "conta fixa" : "conta a pagar", valor: Math.round(-t.amount_cents) / 100, periodo: "", situacao: "a pagar" });
  }
  for (const mes of FUTUROS) for (const [desc, valor, categoria, dia] of PREVISTOS) {
    const data = `${mes}-${String(dia).padStart(2, "0")}`;
    // Se o boleto real desse mes ja estiver lancado (mesmo valor, mesmo mes), nao prever de novo.
    const jaLancado = txs.some((t) => t.date.slice(0, 7) === mes && Math.abs(Math.abs(t.amount_cents) / 100 - valor) < 0.01);
    if (!jaLancado) due.push({ data, descricao: desc, origem: "previsto pelo histórico", tipo: "boleto previsto", valor, periodo: categoria, situacao: "estimativa" });
  }
  due.sort((a, b) => String(a.data).localeCompare(String(b.data)));
  writeFileSync(join(outDir, "vencimentos.json"), JSON.stringify(due), "utf8");

  // Sem categoria definida.
  const unknown = txs.filter((t) => catName.get(t.category_id) === "Não identificado" && t.date >= "2026-08-01" && !t.oposite_transaction_id)
    .sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents))
    .map((t) => ({ id: t.id, data: t.date, origem: where(t), descricao: t.description, valor: Math.round(t.amount_cents) / 100 }));
  writeFileSync(join(outDir, "nao-identificado.json"), JSON.stringify(unknown), "utf8");

  return { lancamentos: rows.length, faturas: faturas.length, gastos: spendRows.length, receitas: incomeRows.length, vencimentos: due.length, nao_identificado: unknown.length };
}

const invokedDirectly = process.argv[1] && /painel-export\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  const out = process.argv[2] || "data/painel";
  exportPainel(out).then((r) => { console.log("exportado em", out, JSON.stringify(r)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
