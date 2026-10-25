/**
 * Rotina diaria sem bot: le a Pluggy, lanca no Organizze o que e novo e regrava os dados do painel.
 *
 *  1. Sync da Pluggy (mesmo motor do bot): novas transacoes viram um lote local.
 *  2. Cada item do lote e decidido por regra, sem esperar revisao:
 *     - duplicado no Organizze -> descartado;
 *     - iFood -> "Lanches e besteiras";
 *     - com categoria sugerida (aliases, aprendizado, categoria da Pluggy) -> lancado nela;
 *     - sem categoria -> lancado em "Não identificado" (o Vitor troca depois no Organizze ou pelo painel).
 *  3. Exporta os JSON do painel para data/painel (ou a pasta passada).
 *
 * Uso: npx tsx scripts/pluggy-diario.ts [pasta do painel] [--ensaio]
 * Com --ensaio nada e gravado no Organizze; a exportacao roda do mesmo jeito.
 * Saida: um resumo em JSON na ultima linha (RESUMO {...}).
 */
import { config } from "../src/config.js";
import { openDatabase } from "../src/repositories/db.js";
import { AliasesRepo } from "../src/repositories/aliases-repo.js";
import { LearningRepo } from "../src/repositories/learning-repo.js";
import { PendingRepo } from "../src/repositories/pending-repo.js";
import { PluggyRepo } from "../src/repositories/pluggy-repo.js";
import { OrganizzeApiService } from "../src/services/organizze-api.js";
import { Categorizer } from "../src/services/categorizer.js";
import { PluggyApiService } from "../src/services/pluggy-api.js";
import { PluggySyncService } from "../src/services/pluggy-sync.js";
import { exportPainel } from "./painel-export.js";

const START_DATE = process.env.PLUGGY_START_DATE || "2026-07-25";
const args = process.argv.slice(2);
const ensaio = args.includes("--ensaio");
const outDir = args.find((a) => !a.startsWith("--")) || "data/painel";

if (!config.pluggy.enabled) throw new Error("Pluggy nao configurada no .env");
const db = openDatabase(config.databasePath);
const aliases = new AliasesRepo(db); const learning = new LearningRepo(db); const pending = new PendingRepo(db); const pluggyRepo = new PluggyRepo(db);
aliases.migrate(); learning.migrate(); pending.migrate(); pluggyRepo.migrate();
const organizze = new OrganizzeApiService(config.organizze);
const catalog = await organizze.getCatalog();
aliases.syncCatalog(catalog);
const categoryByName = new Map(catalog.categories.map((c) => [c.name.trim(), c]));
const lanches = categoryByName.get("Lanches e besteiras");
const naoIdentificado = categoryByName.get("Não identificado");
if (!naoIdentificado) throw new Error('categoria "Não identificado" nao existe no Organizze');

const service = new PluggySyncService(
  { api: new PluggyApiService({ clientId: config.pluggy.clientId, clientSecret: config.pluggy.clientSecret }), repo: pluggyRepo, aliasesRepo: aliases, categorizer: new Categorizer(aliases, config.defaults, learning), pendingRepo: pending, organizzeApi: organizze },
  { items: [...config.pluggy.items], startDate: START_DATE, confidenceThreshold: config.confidenceThreshold }
);
const result = await service.sync({ chatId: config.pluggy.notifyChatId ?? config.allowedTelegramUserIds[0] ?? 0 });

const resumo = { data: new Date().toISOString().slice(0, 10), ensaio, contas: result.accounts, novas: result.candidates, duplicadas: 0, lancadas: 0, sem_categoria: 0, ifood: 0, erros: result.errors.map((e) => `${e.scope}: ${e.message}`), sem_mapeamento: result.unmapped.map((u) => `${u.itemName} ${u.name}`), lancamentos: [] as string[] };

// Processa o lote de hoje e tambem itens de lotes antigos que ficaram sem decisao (status local "batched").
const batchIds = (db.prepare("SELECT DISTINCT batch_id FROM pluggy_transactions WHERE status = 'batched' AND batch_id IS NOT NULL").all() as Array<{ batch_id: string }>).map((r) => r.batch_id);
const batches = batchIds.map((id) => pending.getImportBatch(id)).filter((b): b is NonNullable<typeof b> => !!b);
if (result.batch && !batches.some((b) => b.id === result.batch!.id)) batches.push(result.batch);
for (const batch of batches) {
  for (const c of batch.candidates) {
    const tx = c.transaction; const pluggyId = c.pluggy_id as string;
    const tracked = pluggyRepo.getTransaction(pluggyId);
    if (!tracked || tracked.status !== "batched") continue;
    if (c.status === "duplicate") {
      resumo.duplicadas += 1;
      if (!ensaio) { const tr = pluggyRepo.getTransaction(pluggyId); if (tr) pluggyRepo.recordTransaction({ pluggyId, accountId: tr.account_id, date: tr.date, amountCents: tr.amount_cents, description: tr.description, status: "skipped", pluggyStatus: tr.pluggy_status, pluggyCreatedAt: tr.pluggy_created_at, payload: JSON.parse(tr.payload_json) }); }
      c.status = "duplicate"; continue;
    }
    let category = tx.category_id ? catalog.categories.find((x) => x.id === tx.category_id) : undefined;
    if (lanches && /ifood|ifd\*/i.test(tx.description || "")) { category = lanches; resumo.ifood += 1; }
    if (!category) { category = naoIdentificado; resumo.sem_categoria += 1; }
    if (!tx.description || tx.amount_cents === undefined || !tx.date || (!tx.account_id && !tx.credit_card_id)) { resumo.erros.push(`sem dados para lancar: ${pluggyId}`); continue; }
    const linha = `${tx.date} ${(tx.amount_cents / 100).toFixed(2)} ${tx.description} -> ${category.name}`;
    resumo.lancamentos.push(linha);
    if (ensaio) continue;
    try {
      const created = await organizze.createTransaction({ description: tx.description, amount_cents: tx.amount_cents, date: tx.date, paid: true, account_id: tx.account_id, credit_card_id: tx.credit_card_id, category_id: category.id, notes: tx.notes });
      pluggyRepo.markImported(pluggyId, created.id);
      c.status = "imported"; c.reason = `Importado no backend: #${created.id}`; c.matched_transaction_id = created.id;
      if (category.id !== naoIdentificado.id) learning.learn({ ...tx, category_id: category.id, category_name: category.name });
      resumo.lancadas += 1;
    } catch (e) {
      resumo.erros.push(`falhou ${linha}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (!ensaio) pending.updateImportBatch(batch);
}

const exportado = await exportPainel(outDir);
db.close();
console.log("RESUMO " + JSON.stringify({ ...resumo, exportado, pasta: outDir }));
process.exit(0);
