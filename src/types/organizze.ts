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
