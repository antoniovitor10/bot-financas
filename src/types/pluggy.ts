export interface PluggyItemConfig {
  id: string;
  name: string;
}

export type PluggyAccountType = "BANK" | "CREDIT";

export interface PluggyCreditData {
  brand?: string | null;
  level?: string | null;
  balanceDueDate?: string | null;
  balanceCloseDate?: string | null;
  creditLimit?: number | null;
  availableCreditLimit?: number | null;
  status?: string | null;
}

export interface PluggyAccount {
  id: string;
  itemId: string;
  type: PluggyAccountType;
  subtype?: string | null;
  name: string;
  marketingName?: string | null;
  balance?: number | null;
  currencyCode?: string | null;
  creditData?: PluggyCreditData | null;
}

export interface PluggyCreditCardMetadata {
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  totalAmount?: number | null;
  purchaseDate?: string | null;
  billPostDate?: string | null;
  paymentType?: string | null;
  cardNumber?: string | null;
}

export interface PluggyMerchant {
  name?: string | null;
  businessName?: string | null;
  cnpj?: string | null;
  category?: string | null;
}

export interface PluggyTransaction {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  descriptionRaw?: string | null;
  category?: string | null;
  categoryId?: string | null;
  type: "DEBIT" | "CREDIT";
  status: "POSTED" | "PENDING";
  operationType?: string | null;
  createdAt?: string;
  updatedAt?: string;
  creditCardMetadata?: PluggyCreditCardMetadata | null;
  merchant?: PluggyMerchant | null;
}

export interface PluggyItem {
  id: string;
  status: string;
  executionStatus?: string;
  lastUpdatedAt?: string | null;
  connector?: { id?: number; name?: string } | null;
}

export type PluggyMapKind = "account" | "credit_card" | "ignore";

export interface PluggyAccountMap {
  pluggy_account_id: string;
  kind: PluggyMapKind;
  target_id?: number;
  target_name?: string;
  auto: boolean;
  updated_at: string;
}

/**
 * deferred: data futura, entra quando chegar | ignored: antes da data de corte (volta se o corte recuar)
 * skipped: descartada por regra ou pelo Vitor (nao volta) | batched: em lote | imported: gravada no backend
 */
export type PluggyTrackedStatus = "deferred" | "ignored" | "skipped" | "batched" | "imported";

export interface PluggyTrackedTransaction {
  pluggy_id: string;
  account_id: string;
  date: string;
  amount_cents: number;
  description: string;
  status: PluggyTrackedStatus;
  pluggy_status: string;
  pluggy_created_at?: string;
  payload_json: string;
  batch_id?: string;
  backend_tx_id?: number;
  created_at: string;
  updated_at: string;
}

export interface PluggySyncState {
  account_id: string;
  last_created_at?: string;
  last_synced_at: string;
  last_error?: string;
}
