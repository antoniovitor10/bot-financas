export type TransactionType = "expense" | "income";
export type TransactionSource = "text" | "voice" | "ofx" | "csv" | "pdf" | "image";
export type AliasKind = "account" | "credit_card" | "category";
export type Periodicity = "monthly" | "yearly" | "weekly" | "biweekly" | "bimonthly" | "trimonthly";

export interface RecurrenceInput {
  periodicity: Periodicity;
}

export interface InstallmentsInput {
  periodicity: Periodicity;
  total: number;
  current?: number;
}

export interface ParsedTransaction {
  type: TransactionType;
  description?: string;
  amount_cents?: number;
  date?: string;
  account_id?: number;
  credit_card_id?: number;
  category_id?: number;
  account_name?: string;
  credit_card_name?: string;
  category_name?: string;
  unresolved_category_name?: string;
  unresolved_account_name?: string;
  unresolved_credit_card_name?: string;
  paid?: boolean;
  recurrence?: RecurrenceInput;
  installments?: InstallmentsInput;
  notes?: string;
  confidence: number;
  missing_fields: string[];
  source: TransactionSource;
  raw_text?: string;
}

export interface TransactionBundle {
  kind: "bundle";
  title: string;
  transactions: ParsedTransaction[];
  notes?: string;
  source: TransactionSource;
  raw_text?: string;
}

export type PendingPayload = ParsedTransaction | TransactionBundle;

export interface AliasTarget {
  kind: AliasKind;
  id: number;
  name: string;
}

export interface PendingConfirmation {
  id: string;
  chat_id: number;
  user_id?: number;
  payload: PendingPayload;
  created_at: string;
  expires_at: string;
}

export interface OfxTransaction {
  fit_id?: string;
  date: string;
  amount_cents: number;
  description: string;
  memo?: string;
}

export type ImportCandidateStatus = "ready" | "duplicate" | "needs_review" | "imported";

export interface ImportCandidate {
  transaction: ParsedTransaction;
  status: ImportCandidateStatus;
  reason?: string;
  matched_transaction_id?: number;
  ofx_fit_id?: string;
}

export interface ImportBatch {
  id: string;
  chat_id: number;
  user_id?: number;
  file_name: string;
  candidates: ImportCandidate[];
  created_at: string;
}
