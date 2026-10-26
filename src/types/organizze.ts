import type { InstallmentsInput, RecurrenceInput } from "./finance.js";

export interface OrganizzeAccount {
  id: number;
  name: string;
  description?: string | null;
  archived?: boolean;
  default?: boolean;
  type?: string;
  balance_cents?: number;
}

export interface OrganizzeCategory {
  id: number;
  name: string;
  color?: string;
  parent_id?: number | null;
}

export interface OrganizzeCreditCard {
  id: number;
  name: string;
  description?: string | null;
  card_network?: string | null;
  closing_day?: number;
  due_day?: number;
  archived?: boolean;
  default?: boolean;
  limit_cents?: number;
}

export interface OrganizzeTransaction {
  id: number;
  oposite_transaction_id?: number | null;
  oposite_account_id?: number | null;
  description: string;
  date: string;
  paid: boolean;
  amount_cents: number;
  total_installments: number;
  installment: number;
  recurring: boolean;
  account_id: number;
  account_type?: "Account" | "CreditCard";
  category_id: number;
  notes?: string | null;
  credit_card_id?: number | null;
  credit_card_invoice_id?: number | null;
}

export interface OrganizzeTransactionCreatePayload {
  description: string;
  amount_cents: number;
  date: string;
  paid?: boolean;
  account_id?: number;
  credit_card_id?: number;
  category_id: number;
  notes?: string;
  recurrence_attributes?: RecurrenceInput;
  installments_attributes?: InstallmentsInput;
}

export interface OrganizzeTransactionUpdatePayload extends Partial<OrganizzeTransactionCreatePayload> {
  /** Move o item para outra fatura do mesmo cartao sem mudar a data. */
  credit_card_invoice_id?: number;
  update_future?: boolean;
  update_all?: boolean;
}

export interface OrganizzeCategoryCreatePayload {
  name: string;
  parent_id?: number | null;
}

export interface OrganizzeAccountUpdatePayload {
  name?: string;
  type?: string;
  description?: string | null;
  archived?: boolean;
  default?: boolean;
}

export interface OrganizzeCreditCardCreatePayload {
  name: string;
  description?: string | null;
  card_network?: string | null;
  closing_day: number;
  due_day: number;
  limit_cents?: number;
  default?: boolean;
}

export interface OrganizzeCreditCardUpdatePayload {
  name?: string;
  description?: string | null;
  card_network?: string | null;
  closing_day?: number;
  due_day?: number;
  limit_cents?: number;
  archived?: boolean;
  default?: boolean;
}

export interface OrganizzeTransferCreatePayload {
  /** Conta de onde o dinheiro sai. */
  debit_account_id: number;
  /** Conta onde o dinheiro entra. */
  credit_account_id: number;
  amount_cents: number;
  date: string;
  paid?: boolean;
  description?: string;
  notes?: string;
  tags?: string[];
}

export interface OrganizzeTransfer {
  id: number;
  description?: string;
  date: string;
  amount_cents: number;
  account_id?: number;
  oposite_account_id?: number;
  oposite_transaction_id?: number;
  notes?: string | null;
}

export interface OrganizzeCreditCardInvoice {
  id: number;
  date: string;
  starting_date: string;
  closing_date: string;
  amount_cents: number;
  payment_amount_cents: number;
  balance_cents: number;
  previous_balance_cents: number;
  credit_card_id: number;
  transactions?: OrganizzeTransaction[];
}

export interface OrganizzeCatalog {
  accounts: OrganizzeAccount[];
  categories: OrganizzeCategory[];
  creditCards: OrganizzeCreditCard[];
}
