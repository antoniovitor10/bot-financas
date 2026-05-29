import { randomUUID } from "node:crypto";
import type { DbConnection } from "./db.js";
import type { ImportBatch, PendingConfirmation } from "../types/finance.js";

interface PendingRow {
  id: string;
  chat_id: number;
  user_id?: number;
  payload_json: string;
  created_at: string;
  expires_at: string;
}

interface ImportRow {
  id: string;
  chat_id: number;
  user_id?: number;
  file_name: string;
  candidates_json: string;
  created_at: string;
}

export class PendingRepo {
  constructor(private readonly db: DbConnection) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_confirmations (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ofx_import_batches (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        file_name TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createPending(payload: Omit<PendingConfirmation, "id" | "created_at" | "expires_at">): PendingConfirmation {
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 60 * 1000);
    const pending: PendingConfirmation = {
      ...payload,
      id: randomUUID().slice(0, 12),
      created_at: now.toISOString(),
      expires_at: expires.toISOString()
    };

    this.db
      .prepare(`
        INSERT INTO pending_confirmations (id, chat_id, user_id, payload_json, created_at, expires_at)
        VALUES (@id, @chatId, @userId, @payload, @createdAt, @expiresAt)
      `)
      .run({
        id: pending.id,
        chatId: pending.chat_id,
        userId: pending.user_id,
        payload: JSON.stringify(pending.payload),
        createdAt: pending.created_at,
        expiresAt: pending.expires_at
      });

    return pending;
  }

  getPending(id: string): PendingConfirmation | undefined {
    const row = this.db.prepare("SELECT * FROM pending_confirmations WHERE id = ?").get(id) as PendingRow | undefined;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deletePending(id);
      return undefined;
    }
    return {
      id: row.id,
      chat_id: row.chat_id,
      user_id: row.user_id,
      payload: JSON.parse(row.payload_json) as PendingConfirmation["payload"],
      created_at: row.created_at,
      expires_at: row.expires_at
    };
  }

  deletePending(id: string): void {
    this.db.prepare("DELETE FROM pending_confirmations WHERE id = ?").run(id);
  }

  updatePendingPayload(id: string, payload: PendingConfirmation["payload"]): void {
    this.db
      .prepare("UPDATE pending_confirmations SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), id);
  }

  deleteByChat(chatId: number): number {
    const result = this.db.prepare("DELETE FROM pending_confirmations WHERE chat_id = ?").run(chatId);
    return result.changes;
  }

  saveImportBatch(batch: Omit<ImportBatch, "id" | "created_at">): ImportBatch {
    const saved: ImportBatch = {
      ...batch,
      id: randomUUID().slice(0, 12),
      created_at: new Date().toISOString()
    };
    this.db
      .prepare(`
        INSERT INTO ofx_import_batches (id, chat_id, user_id, file_name, candidates_json, created_at)
        VALUES (@id, @chatId, @userId, @fileName, @candidates, @createdAt)
      `)
      .run({
        id: saved.id,
        chatId: saved.chat_id,
        userId: saved.user_id,
        fileName: saved.file_name,
        candidates: JSON.stringify(saved.candidates),
        createdAt: saved.created_at
      });
    return saved;
  }

  getImportBatch(id: string): ImportBatch | undefined {
    const row = this.db.prepare("SELECT * FROM ofx_import_batches WHERE id = ?").get(id) as ImportRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      chat_id: row.chat_id,
      user_id: row.user_id,
      file_name: row.file_name,
      candidates: JSON.parse(row.candidates_json) as ImportBatch["candidates"],
      created_at: row.created_at
    };
  }

  updateImportBatch(batch: ImportBatch): void {
    this.db
      .prepare("UPDATE ofx_import_batches SET candidates_json = ? WHERE id = ?")
      .run(JSON.stringify(batch.candidates), batch.id);
  }
}
