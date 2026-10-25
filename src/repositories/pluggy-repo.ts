import type { DbConnection } from "./db.js";
import type {
  PluggyAccount,
  PluggyAccountMap,
  PluggyMapKind,
  PluggySyncState,
  PluggyTrackedStatus,
  PluggyTrackedTransaction
} from "../types/pluggy.js";

export interface PluggyCachedAccount {
  id: string;
  item_id: string;
  item_name: string;
  type: string;
  subtype?: string;
  name: string;
  brand?: string;
  balance?: number;
  last_seen_at: string;
}

interface AccountRow {
  id: string;
  item_id: string;
  item_name: string;
  type: string;
  subtype: string | null;
  name: string;
  brand: string | null;
  balance: number | null;
  last_seen_at: string;
}

interface MapRow {
  pluggy_account_id: string;
  kind: PluggyMapKind;
  target_id: number | null;
  target_name: string | null;
  auto: number;
  updated_at: string;
}

interface TrackedRow {
  pluggy_id: string;
  account_id: string;
  date: string;
  amount_cents: number;
  description: string;
  status: PluggyTrackedStatus;
  pluggy_status: string;
  pluggy_created_at: string | null;
  payload_json: string;
  batch_id: string | null;
  backend_tx_id: number | null;
  created_at: string;
  updated_at: string;
}

interface StateRow {
  account_id: string;
  last_created_at: string | null;
  last_synced_at: string;
  last_error: string | null;
}

export class PluggyRepo {
  constructor(private readonly db: DbConnection) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pluggy_accounts (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        type TEXT NOT NULL,
        subtype TEXT,
        name TEXT NOT NULL,
        brand TEXT,
        balance REAL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pluggy_account_map (
        pluggy_account_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id INTEGER,
        target_name TEXT,
        auto INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pluggy_transactions (
        pluggy_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        pluggy_status TEXT NOT NULL,
        pluggy_created_at TEXT,
        payload_json TEXT NOT NULL,
        batch_id TEXT,
        backend_tx_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pluggy_transactions_status_date ON pluggy_transactions (status, date);

      CREATE TABLE IF NOT EXISTS pluggy_sync_state (
        account_id TEXT PRIMARY KEY,
        last_created_at TEXT,
        last_synced_at TEXT NOT NULL,
        last_error TEXT
      );
    `);
  }

  // ── contas ──
  upsertAccount(account: PluggyAccount, itemName: string): void {
    this.db
      .prepare(`
        INSERT INTO pluggy_accounts (id, item_id, item_name, type, subtype, name, brand, balance, last_seen_at)
        VALUES (@id, @itemId, @itemName, @type, @subtype, @name, @brand, @balance, @seenAt)
        ON CONFLICT(id) DO UPDATE SET
          item_id = excluded.item_id,
          item_name = excluded.item_name,
          type = excluded.type,
          subtype = excluded.subtype,
          name = excluded.name,
          brand = excluded.brand,
          balance = excluded.balance,
          last_seen_at = excluded.last_seen_at
      `)
      .run({
        id: account.id,
        itemId: account.itemId,
        itemName,
        type: account.type,
        subtype: account.subtype ?? null,
        name: account.name,
        brand: account.creditData?.brand ?? null,
        balance: account.balance ?? null,
        seenAt: new Date().toISOString()
      });
  }

  listAccounts(): PluggyCachedAccount[] {
    return (this.db
      .prepare("SELECT * FROM pluggy_accounts ORDER BY item_name, type, name")
      .all() as AccountRow[]).map(toAccount);
  }

  findAccountByPrefix(prefix: string): PluggyCachedAccount | undefined {
    const normalized = prefix.trim().toLowerCase();
    if (normalized.length < 4) return undefined;
    return this.listAccounts().find((account) => account.id.toLowerCase().startsWith(normalized));
  }

  // ── mapeamento conta Pluggy -> conta/cartao do backend ──
  getMap(pluggyAccountId: string): PluggyAccountMap | undefined {
    const row = this.db
      .prepare("SELECT * FROM pluggy_account_map WHERE pluggy_account_id = ?")
      .get(pluggyAccountId) as MapRow | undefined;
    return row ? toMap(row) : undefined;
  }

  listMaps(): PluggyAccountMap[] {
    return (this.db.prepare("SELECT * FROM pluggy_account_map").all() as MapRow[]).map(toMap);
  }

  setMap(input: { pluggyAccountId: string; kind: PluggyMapKind; targetId?: number; targetName?: string; auto?: boolean }): void {
    this.db
      .prepare(`
        INSERT INTO pluggy_account_map (pluggy_account_id, kind, target_id, target_name, auto, updated_at)
        VALUES (@id, @kind, @targetId, @targetName, @auto, @updatedAt)
        ON CONFLICT(pluggy_account_id) DO UPDATE SET
          kind = excluded.kind,
          target_id = excluded.target_id,
          target_name = excluded.target_name,
          auto = excluded.auto,
          updated_at = excluded.updated_at
      `)
      .run({
        id: input.pluggyAccountId,
        kind: input.kind,
        targetId: input.targetId ?? null,
        targetName: input.targetName ?? null,
        auto: input.auto ? 1 : 0,
        updatedAt: new Date().toISOString()
      });
  }

  clearMap(pluggyAccountId: string): boolean {
    return this.db.prepare("DELETE FROM pluggy_account_map WHERE pluggy_account_id = ?").run(pluggyAccountId).changes > 0;
  }

  // ── transacoes rastreadas ──
  hasTransaction(pluggyId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pluggy_transactions WHERE pluggy_id = ?").get(pluggyId);
  }

  getTransaction(pluggyId: string): PluggyTrackedTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM pluggy_transactions WHERE pluggy_id = ?").get(pluggyId) as TrackedRow | undefined;
    return row ? toTracked(row) : undefined;
  }

  recordTransaction(input: {
    pluggyId: string;
    accountId: string;
    date: string;
    amountCents: number;
    description: string;
    status: PluggyTrackedStatus;
    pluggyStatus: string;
    pluggyCreatedAt?: string;
    payload: unknown;
    batchId?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO pluggy_transactions (
          pluggy_id, account_id, date, amount_cents, description, status, pluggy_status,
          pluggy_created_at, payload_json, batch_id, backend_tx_id, created_at, updated_at
        )
        VALUES (
          @pluggyId, @accountId, @date, @amountCents, @description, @status, @pluggyStatus,
          @pluggyCreatedAt, @payload, @batchId, NULL, @now, @now
        )
        ON CONFLICT(pluggy_id) DO UPDATE SET
          date = excluded.date,
          amount_cents = excluded.amount_cents,
          description = excluded.description,
          status = excluded.status,
          pluggy_status = excluded.pluggy_status,
          payload_json = excluded.payload_json,
          batch_id = COALESCE(excluded.batch_id, pluggy_transactions.batch_id),
          updated_at = excluded.updated_at
      `)
      .run({
        pluggyId: input.pluggyId,
        accountId: input.accountId,
        date: input.date,
        amountCents: input.amountCents,
        description: input.description,
        status: input.status,
        pluggyStatus: input.pluggyStatus,
        pluggyCreatedAt: input.pluggyCreatedAt ?? null,
        payload: JSON.stringify(input.payload),
        batchId: input.batchId ?? null,
        now
      });
  }

  /** Transacoes adiadas (data futura) cuja data ja chegou. */
  listDeferredDue(todayIso: string): PluggyTrackedTransaction[] {
    return (this.db
      .prepare("SELECT * FROM pluggy_transactions WHERE status = 'deferred' AND date <= ? ORDER BY date")
      .all(todayIso) as TrackedRow[]).map(toTracked);
  }

  /** Transacoes ignoradas por estarem antes do corte, caso o corte tenha recuado. Descartadas ("skipped") nunca voltam. */
  listIgnoredSince(startDateIso: string): PluggyTrackedTransaction[] {
    return (this.db
      .prepare("SELECT * FROM pluggy_transactions WHERE status = 'ignored' AND date >= ? ORDER BY date")
      .all(startDateIso) as TrackedRow[]).map(toTracked);
  }

  markBatched(pluggyIds: string[], batchId: string): void {
    const statement = this.db.prepare(
      "UPDATE pluggy_transactions SET status = 'batched', batch_id = ?, updated_at = ? WHERE pluggy_id = ?"
    );
    const now = new Date().toISOString();
    const run = this.db.transaction((ids: string[]) => {
      for (const id of ids) statement.run(batchId, now, id);
    });
    run(pluggyIds);
  }

  markImported(pluggyId: string, backendTxId: number): void {
    this.db
      .prepare("UPDATE pluggy_transactions SET status = 'imported', backend_tx_id = ?, updated_at = ? WHERE pluggy_id = ?")
      .run(backendTxId, new Date().toISOString(), pluggyId);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS total FROM pluggy_transactions GROUP BY status")
      .all() as Array<{ status: string; total: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.total]));
  }

  // ── estado de sync por conta ──
  getSyncState(accountId: string): PluggySyncState | undefined {
    const row = this.db.prepare("SELECT * FROM pluggy_sync_state WHERE account_id = ?").get(accountId) as StateRow | undefined;
    return row ? toState(row) : undefined;
  }

  listSyncStates(): PluggySyncState[] {
    return (this.db.prepare("SELECT * FROM pluggy_sync_state").all() as StateRow[]).map(toState);
  }

  setSyncState(input: { accountId: string; lastCreatedAt?: string; lastError?: string }): void {
    this.db
      .prepare(`
        INSERT INTO pluggy_sync_state (account_id, last_created_at, last_synced_at, last_error)
        VALUES (@accountId, @lastCreatedAt, @now, @lastError)
        ON CONFLICT(account_id) DO UPDATE SET
          last_created_at = COALESCE(excluded.last_created_at, pluggy_sync_state.last_created_at),
          last_synced_at = excluded.last_synced_at,
          last_error = excluded.last_error
      `)
      .run({
        accountId: input.accountId,
        lastCreatedAt: input.lastCreatedAt ?? null,
        now: new Date().toISOString(),
        lastError: input.lastError ?? null
      });
  }
}

function toAccount(row: AccountRow): PluggyCachedAccount {
  return {
    id: row.id,
    item_id: row.item_id,
    item_name: row.item_name,
    type: row.type,
    subtype: row.subtype ?? undefined,
    name: row.name,
    brand: row.brand ?? undefined,
    balance: row.balance ?? undefined,
    last_seen_at: row.last_seen_at
  };
}

function toMap(row: MapRow): PluggyAccountMap {
  return {
    pluggy_account_id: row.pluggy_account_id,
    kind: row.kind,
    target_id: row.target_id ?? undefined,
    target_name: row.target_name ?? undefined,
    auto: row.auto === 1,
    updated_at: row.updated_at
  };
}

function toTracked(row: TrackedRow): PluggyTrackedTransaction {
  return {
    pluggy_id: row.pluggy_id,
    account_id: row.account_id,
    date: row.date,
    amount_cents: row.amount_cents,
    description: row.description,
    status: row.status,
    pluggy_status: row.pluggy_status,
    pluggy_created_at: row.pluggy_created_at ?? undefined,
    payload_json: row.payload_json,
    batch_id: row.batch_id ?? undefined,
    backend_tx_id: row.backend_tx_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toState(row: StateRow): PluggySyncState {
  return {
    account_id: row.account_id,
    last_created_at: row.last_created_at ?? undefined,
    last_synced_at: row.last_synced_at,
    last_error: row.last_error ?? undefined
  };
}
