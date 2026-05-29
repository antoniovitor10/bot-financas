import type { DbConnection } from "./db.js";
import type { AliasKind, AliasTarget } from "../types/finance.js";
import type { OrganizzeCatalog } from "../types/organizze.js";

interface AliasRow {
  kind: AliasKind;
  alias: string;
  target_id: number;
  target_name: string;
}

interface CatalogRow {
  kind: AliasKind;
  id: number;
  name: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function tokenMatches(aliasToken: string, textTokens: Set<string>): boolean {
  if (textTokens.has(aliasToken)) return true;
  if (aliasToken.endsWith("s") && textTokens.has(aliasToken.slice(0, -1))) return true;
  if (!aliasToken.endsWith("s") && textTokens.has(`${aliasToken}s`)) return true;
  return false;
}

function meaningfulToken(token: string): boolean {
  return token.length >= 4 && !new Set(["para", "com", "sem", "servicos", "servico"]).has(token);
}

function aliasMatches(normalizedText: string, alias: string): boolean {
  if (` ${normalizedText} `.includes(` ${alias} `)) return true;

  const aliasCompact = compact(alias);
  const textCompact = compact(normalizedText);
  if (aliasCompact.length >= 4 && textCompact.includes(aliasCompact)) return true;

  const aliasTokens = tokens(alias);
  const textTokenSet = new Set(tokens(normalizedText));
  if (aliasTokens.length === 0) return false;
  if (aliasTokens.some((token) => meaningfulToken(token) && tokenMatches(token, textTokenSet))) return true;
  return aliasTokens.every((token) => tokenMatches(token, textTokenSet));
}

export class AliasesRepo {
  constructor(private readonly db: DbConnection) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aliases (
        kind TEXT NOT NULL,
        alias TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        target_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, alias)
      );

      CREATE TABLE IF NOT EXISTS organizze_catalog (
        kind TEXT NOT NULL,
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, id)
      );
    `);
  }

  normalizeAlias(value: string): string {
    return normalize(value);
  }

  syncCatalog(catalog: OrganizzeCatalog): void {
    const sync = this.db.transaction(() => {
      this.db.prepare("DELETE FROM organizze_catalog").run();
      for (const account of catalog.accounts) {
        this.upsertCatalogItem("account", account.id, account.name, account);
        this.upsertAlias("account", account.name, account.id, account.name);
      }
      for (const category of catalog.categories) {
        this.upsertCatalogItem("category", category.id, category.name, category);
        this.upsertAlias("category", category.name, category.id, category.name);
        for (const token of tokens(category.name).filter(meaningfulToken)) {
          this.upsertAlias("category", token, category.id, category.name);
        }
      }
      for (const card of catalog.creditCards) {
        this.upsertCatalogItem("credit_card", card.id, card.name, card);
        this.upsertAlias("credit_card", card.name, card.id, card.name);
        this.upsertAlias("credit_card", compact(card.name), card.id, card.name);
      }
    });
    sync();
  }

  upsertCatalogItem(kind: AliasKind, id: number, name: string, payload: unknown): void {
    this.db
      .prepare(`
        INSERT INTO organizze_catalog (kind, id, name, payload_json, synced_at)
        VALUES (@kind, @id, @name, @payload, CURRENT_TIMESTAMP)
        ON CONFLICT(kind, id) DO UPDATE SET
          name = excluded.name,
          payload_json = excluded.payload_json,
          synced_at = CURRENT_TIMESTAMP
      `)
      .run({ kind, id, name, payload: JSON.stringify(payload) });
  }

  upsertAlias(kind: AliasKind, alias: string, targetId: number, targetName: string): void {
    const normalized = normalize(alias);
    if (!normalized) return;
    this.db
      .prepare(`
        INSERT INTO aliases (kind, alias, target_id, target_name, created_at, updated_at)
        VALUES (@kind, @alias, @targetId, @targetName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(kind, alias) DO UPDATE SET
          target_id = excluded.target_id,
          target_name = excluded.target_name,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run({ kind, alias: normalized, targetId, targetName });
  }

  findAlias(kind: AliasKind, alias: string): AliasTarget | undefined {
    const row = this.db
      .prepare("SELECT kind, target_id, target_name FROM aliases WHERE kind = ? AND alias = ?")
      .get(kind, normalize(alias)) as Pick<AliasRow, "kind" | "target_id" | "target_name"> | undefined;
    if (!row) return undefined;
    return { kind: row.kind, id: row.target_id, name: row.target_name };
  }

  findMention(kind: AliasKind, text: string): AliasTarget | undefined {
    const normalizedText = normalize(text);
    const rows = this.db
      .prepare("SELECT kind, alias, target_id, target_name FROM aliases WHERE kind = ? ORDER BY length(alias) DESC")
      .all(kind) as AliasRow[];

    for (const row of rows) {
      if (aliasMatches(normalizedText, row.alias)) {
        return { kind: row.kind, id: row.target_id, name: row.target_name };
      }
    }

    return undefined;
  }

  getCatalog(kind: AliasKind): AliasTarget[] {
    const rows = this.db
      .prepare("SELECT kind, id, name FROM organizze_catalog WHERE kind = ? ORDER BY name")
      .all(kind) as CatalogRow[];
    return rows.map((row) => ({ kind: row.kind, id: row.id, name: row.name }));
  }

  findCatalogById(kind: AliasKind, id: number): AliasTarget | undefined {
    const row = this.db
      .prepare("SELECT kind, id, name FROM organizze_catalog WHERE kind = ? AND id = ?")
      .get(kind, id) as CatalogRow | undefined;
    return row ? { kind: row.kind, id: row.id, name: row.name } : undefined;
  }

  listAliases(): AliasRow[] {
    return this.db
      .prepare("SELECT kind, alias, target_id, target_name FROM aliases ORDER BY kind, alias")
      .all() as AliasRow[];
  }
}
