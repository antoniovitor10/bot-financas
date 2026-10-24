/**
 * Aplica no backend financeiro as decisoes tomadas na pagina de revisao da Pluggy.
 *
 * Entrada: uma pasta com um JSON por decisao (como o ArtifactData salva com out_dir:
 * <pasta>/decisoes/<pluggyId>.json, cada um com { action, category_id, dest_kind, dest_id, ... }).
 * Para cada decisao "lancar": cria a transacao no backend com "Pluggy <id>" nas notas,
 * marca como importada no SQLite do bot, atualiza o lote e alimenta o aprendizado.
 * Para "ignorar": marca a transacao local como ignorada (nao volta em lotes futuros).
 *
 * Uso (de dentro da pasta do projeto, le o .env):
 *   npx tsx scripts/pluggy-import-decisoes.ts <pasta-das-decisoes> [--apply] [--caixa-card=ID]
 * Sem --apply e um ensaio: mostra o que faria e nao grava nada.
 * --caixa-card=ID informa o id do cartao do Organizze para as linhas do cartao Caixa (dest_id nulo).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { openDatabase } from "../src/repositories/db.js";
import { AliasesRepo } from "../src/repositories/aliases-repo.js";
import { LearningRepo } from "../src/repositories/learning-repo.js";
import { PendingRepo } from "../src/repositories/pending-repo.js";
import { PluggyRepo } from "../src/repositories/pluggy-repo.js";
import { OrganizzeApiService } from "../src/services/organizze-api.js";
import { FinControlApiService } from "../src/services/fincontrol-api.js";
import { toParsedTransaction } from "../src/services/pluggy-sync.js";
import type { ParsedTransaction } from "../src/types/finance.js";
import type { PluggyTransaction } from "../src/types/pluggy.js";
import { formatBRL } from "../src/utils/money.js";

interface Decision {
  action: "lancar" | "ignorar";
  category_id: number | null;
  category_name?: string | null;
  dest_kind?: "account" | "credit_card" | null;
  dest_id?: number | null;
  amount_cents?: number;
  date?: string;
  description?: string;
  via?: string;
}

const args = process.argv.slice(2);
const folder = args.find((arg) => !arg.startsWith("--"));
const apply = args.includes("--apply");
const caixaCardArg = args.find((arg) => arg.startsWith("--caixa-card="));
const caixaCardId = caixaCardArg ? Number(caixaCardArg.split("=")[1]) : undefined;
if (!folder) {
  console.error("uso: npx tsx scripts/pluggy-import-decisoes.ts <pasta-das-decisoes> [--apply] [--caixa-card=ID]");
  process.exit(1);
}

function readDecisions(root: string): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
      // Aceita tanto o documento puro quanto o envelope { id, data, version } do ArtifactData.
      const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Decision;
      const id = (typeof raw.id === "string" ? raw.id : name.replace(/\.json$/, ""));
      if (data.action === "lancar" || data.action === "ignorar") decisions.set(id, data);
    }
  };
  walk(root);
  return decisions;
}

const decisions = readDecisions(folder);
console.log(`decisoes lidas: ${decisions.size} (${[...decisions.values()].filter((d) => d.action === "lancar").length} lancar, ${[...decisions.values()].filter((d) => d.action === "ignorar").length} ignorar)`);

const db = openDatabase(config.databasePath);
const aliases = new AliasesRepo(db);
const learning = new LearningRepo(db);
const pending = new PendingRepo(db);
const pluggyRepo = new PluggyRepo(db);
aliases.migrate(); learning.migrate(); pending.migrate(); pluggyRepo.migrate();

const backend = config.financeBackend === "fincontrol"
  ? (new FinControlApiService(config.fincontrol) as unknown as OrganizzeApiService)
  : new OrganizzeApiService(config.organizze);
const catalog = await backend.getCatalog();
aliases.syncCatalog(catalog);
const categoryName = new Map(catalog.categories.map((c) => [c.id, c.name]));
const accountName = new Map(catalog.accounts.map((a) => [a.id, a.name]));
const cardName = new Map(catalog.creditCards.map((c) => [c.id, c.name]));

const accounts = new Map(pluggyRepo.listAccounts().map((a) => [a.id, a]));
const batches = new Map<string, ReturnType<PendingRepo["getImportBatch"]>>();

const report: string[] = [];
let created = 0, ignored = 0, skipped = 0, failed = 0;

for (const [pluggyId, decision] of decisions) {
  const tracked = pluggyRepo.getTransaction(pluggyId);
  if (tracked?.status === "imported") { skipped += 1; report.push(`ja importada ${pluggyId.slice(0, 8)} #${tracked.backend_tx_id}`); continue; }

  if (decision.action === "ignorar") {
    if (apply && tracked) {
      pluggyRepo.recordTransaction({
        pluggyId, accountId: tracked.account_id, date: tracked.date, amountCents: tracked.amount_cents,
        description: tracked.description, status: "ignored", pluggyStatus: tracked.pluggy_status,
        pluggyCreatedAt: tracked.pluggy_created_at, payload: JSON.parse(tracked.payload_json)
      });
    }
    ignored += 1;
    continue;
  }

  // lancar
  if (!decision.category_id || !categoryName.has(decision.category_id)) {
    failed += 1; report.push(`SEM CATEGORIA ${pluggyId.slice(0, 8)} ${decision.date} ${decision.description}`); continue;
  }
  let destKind = decision.dest_kind ?? null;
  let destId = decision.dest_id ?? null;
  if (destKind === "credit_card" && !destId && caixaCardId) destId = caixaCardId;
  if (!destKind || !destId) { failed += 1; report.push(`SEM DESTINO ${pluggyId.slice(0, 8)} ${decision.date} ${decision.description} (use --caixa-card=ID)`); continue; }
  const destOk = destKind === "credit_card" ? cardName.has(destId) : accountName.has(destId);
  if (!destOk) { failed += 1; report.push(`DESTINO INVALIDO ${pluggyId.slice(0, 8)} ${destKind} #${destId}`); continue; }

  // Reconstroi a transacao a partir do payload da Pluggy guardado (ou da propria decisao, para o cartao Caixa).
  let parsed: ParsedTransaction;
  if (tracked) {
    const tx = JSON.parse(tracked.payload_json) as PluggyTransaction;
    const acc = accounts.get(tracked.account_id);
    parsed = toParsedTransaction(tx, { type: acc?.type || (destKind === "credit_card" ? "CREDIT" : "BANK"), name: acc?.name || "", itemName: acc?.item_name || "" });
  } else {
    if (decision.amount_cents === undefined || !decision.date || !decision.description) { failed += 1; report.push(`SEM DADOS ${pluggyId.slice(0, 8)}`); continue; }
    parsed = {
      type: decision.amount_cents < 0 ? "expense" : "income", description: decision.description, amount_cents: decision.amount_cents,
      date: decision.date, paid: true, notes: `Pluggy ${pluggyId} | Caixa cartao`, confidence: 0.9, missing_fields: [], source: "pluggy"
    };
  }
  parsed.category_id = decision.category_id;
  parsed.category_name = categoryName.get(decision.category_id);
  // A revisao pode melhorar a descricao (ex.: nome de quem recebeu o Pix).
  if (decision.description && decision.description.trim() && decision.description.trim() !== parsed.description) {
    parsed.description = decision.description.trim().slice(0, 80);
  }
  if (destKind === "credit_card") { parsed.credit_card_id = destId; parsed.credit_card_name = cardName.get(destId); delete parsed.account_id; delete parsed.account_name; }
  else { parsed.account_id = destId; parsed.account_name = accountName.get(destId); delete parsed.credit_card_id; delete parsed.credit_card_name; }

  const line = `${parsed.date} ${formatBRL(parsed.amount_cents)} ${parsed.description} -> ${destKind === "credit_card" ? "cartao" : "conta"} ${destKind === "credit_card" ? cardName.get(destId) : accountName.get(destId)} | ${parsed.category_name}`;
  if (!apply) { created += 1; report.push(`criaria ${line}`); continue; }

  try {
    const createdTx = await backend.createTransaction({
      description: parsed.description!, amount_cents: parsed.amount_cents!, date: parsed.date!, paid: true,
      account_id: parsed.account_id, credit_card_id: parsed.credit_card_id, category_id: parsed.category_id!, notes: parsed.notes
    });
    created += 1;
    if (tracked) {
      pluggyRepo.markImported(pluggyId, createdTx.id);
      if (tracked.batch_id) {
        const batch = batches.get(tracked.batch_id) ?? pending.getImportBatch(tracked.batch_id);
        batches.set(tracked.batch_id, batch);
        const candidate = batch?.candidates.find((c) => c.pluggy_id === pluggyId);
        if (candidate) { candidate.status = "imported"; candidate.reason = `Importado no backend: #${createdTx.id}`; candidate.matched_transaction_id = createdTx.id; candidate.transaction = parsed; }
      }
    }
    learning.learn(parsed);
    report.push(`criada #${createdTx.id} ${line}`);
  } catch (error) {
    failed += 1;
    report.push(`FALHOU ${pluggyId.slice(0, 8)} ${line}: ${(error as Error).message}`);
  }
}

if (apply) for (const batch of batches.values()) if (batch) pending.updateImportBatch(batch);

const summary = `${apply ? "APLICADO" : "ENSAIO"}: criadas ${created} | ignoradas ${ignored} | ja importadas ${skipped} | com problema ${failed}`;
console.log(summary);
for (const line of report) console.log("  " + line);
const reportPath = join(folder, `relatorio-${apply ? "aplicado" : "ensaio"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`);
writeFileSync(reportPath, [summary, ...report].join("\n"), "utf8");
console.log("relatorio:", reportPath);
db.close();
