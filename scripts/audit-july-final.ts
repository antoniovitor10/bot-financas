import { config } from "../src/config.js";

type Transaction = {
  id: number;
  description: string;
  date: string;
  amount_cents: number;
  category_id?: number | null;
  account_id?: number | null;
  credit_card_id?: number | null;
  credit_card_invoice_id?: number | null;
  paid?: boolean;
  notes?: string | null;
};

type Account = {
  id: number;
  name: string;
  balance_cents?: number;
  balance?: number;
};

type Category = {
  id: number;
  name: string;
};

type Invoice = {
  id: number;
  date: string;
  starting_date?: string;
  closing_date?: string;
  balance_cents: number;
  amount_cents?: number;
  previous_balance_cents?: number;
};

const baseUrl = config.organizze.baseUrl.replace(/\/$/, "");
const auth = `Basic ${Buffer.from(`${config.organizze.email}:${config.organizze.token}`).toString("base64")}`;

const ACCOUNT_IDS = new Set([6272892, 10118745, 6272886, 10025309]);
const CARD_NAMES = new Map([
  [1723006, "Inter"],
  [1723018, "Mercado Pago"],
  [1723021, "Nubank"],
  [1723007, "PicPay"],
  [2160387, "Amazon"],
  [2262054, "C&A"]
]);
const EXCLUDED_CATEGORIES = new Set([79404732, 79404722, 164258344]);
const THIRD_PARTY_CATEGORIES = new Set([153685499, 157306754, 164714649, 164714868]);
const NON_EFFECTIVE_EXPENSE_CATEGORIES = new Set([
  ...EXCLUDED_CATEGORIES,
  ...THIRD_PARTY_CATEGORIES,
  79404723
]);
const RECONCILIATION_MARKER = "reconcile-july-2026:";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: auth,
      Accept: "application/json",
      "User-Agent": config.organizze.userAgent
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (value: string): Set<string> =>
  new Set(normalize(value).split(" ").filter((token) => token.length >= 3 && !["pix", "recebido", "pagamento"].includes(token)));

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

const daysApart = (left: string, right: string): number =>
  Math.abs((Date.parse(`${left}T12:00:00Z`) - Date.parse(`${right}T12:00:00Z`)) / 86_400_000);

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const accountList = await request<Account[]>("/accounts");
const accounts = await Promise.all(
  accountList
    .filter((account) => ACCOUNT_IDS.has(account.id))
    .map((account) => request<Account>(`/accounts/${account.id}`))
);
const categories = await request<Category[]>("/categories");
const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

const monthlyTransactions: Transaction[] = [];
for (const month of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
  const lastDay = month === "2026-06" || month === "2026-09" ? "30" : "31";
  monthlyTransactions.push(
    ...(await request<Transaction[]>(`/transactions?start_date=${month}-01&end_date=${month}-${lastDay}`))
  );
}

const allTransactions = [...new Map(monthlyTransactions.map((transaction) => [transaction.id, transaction])).values()];
const reconciled = allTransactions.filter((transaction) => transaction.notes?.includes(RECONCILIATION_MARKER));
const oldPending = allTransactions.filter((transaction) =>
  !transaction.notes?.includes(RECONCILIATION_MARKER) &&
  transaction.paid === false &&
  !transaction.credit_card_id
);

const duplicateCandidates = oldPending.flatMap((oldTransaction) => {
  const matches = reconciled
    .filter((candidate) =>
      candidate.account_id === oldTransaction.account_id &&
      candidate.amount_cents === oldTransaction.amount_cents &&
      daysApart(candidate.date, oldTransaction.date) <= 15
    )
    .map((candidate) => ({
      old_id: oldTransaction.id,
      old_date: oldTransaction.date,
      old_description: oldTransaction.description,
      old_amount_cents: oldTransaction.amount_cents,
      new_id: candidate.id,
      new_date: candidate.date,
      new_description: candidate.description,
      similarity: similarity(oldTransaction.description, candidate.description)
    }))
    .filter((candidate) => candidate.similarity >= 0.2);
  return matches;
});

const july = allTransactions.filter((transaction) => transaction.date >= "2026-07-01" && transaction.date <= "2026-07-31");
const julyExpenses = july.filter((transaction) =>
  transaction.amount_cents < 0 &&
  (Boolean(transaction.credit_card_id) || transaction.paid !== false) &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0) &&
  !normalize(transaction.description).includes("ajuste")
);

const categoryTotals = new Map<number, number>();
for (const transaction of julyExpenses) {
  const categoryId = transaction.category_id || 0;
  categoryTotals.set(categoryId, (categoryTotals.get(categoryId) || 0) + Math.abs(transaction.amount_cents));
}

const accountCashflow = july.filter((transaction) =>
  ACCOUNT_IDS.has(transaction.account_id || 0) &&
  !transaction.credit_card_id &&
  transaction.paid !== false &&
  !normalize(transaction.description).includes("ajuste")
);
const operationalCashflow = accountCashflow.filter((transaction) => !EXCLUDED_CATEGORIES.has(transaction.category_id || 0));

const invoices: Array<Invoice & { card_id: number; card_name: string }> = [];
const augustThirdPartyCardTransactions: Array<Transaction & { card_name: string }> = [];
const augustAllCardTransactions: Array<Transaction & { card_name: string }> = [];
for (const [cardId, cardName] of CARD_NAMES) {
  const cardInvoices = await request<Invoice[]>(
    `/credit_cards/${cardId}/invoices?start_date=2026-08-01&end_date=2026-08-31`
  );
  for (const invoice of cardInvoices) {
    invoices.push({ ...invoice, card_id: cardId, card_name: cardName });
    const detail = await request<{ transactions?: Transaction[] }>(
      `/credit_cards/${cardId}/invoices/${invoice.id}`
    );
    augustAllCardTransactions.push(
      ...(detail.transactions || []).map((transaction) => ({ ...transaction, card_name: cardName }))
    );
    augustThirdPartyCardTransactions.push(
      ...(detail.transactions || [])
        .filter((transaction) => THIRD_PARTY_CATEGORIES.has(transaction.category_id || 0))
        .map((transaction) => ({ ...transaction, card_name: cardName }))
    );
  }
}

const augustScheduled = allTransactions.filter((transaction) =>
  transaction.date >= "2026-08-01" &&
  transaction.date <= "2026-08-31" &&
  transaction.paid === false &&
  !transaction.credit_card_id &&
  transaction.amount_cents < 0 &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0)
);
const augustExpectedIncome = allTransactions.filter((transaction) =>
  transaction.date >= "2026-08-01" &&
  transaction.date <= "2026-08-31" &&
  transaction.paid === false &&
  !transaction.credit_card_id &&
  transaction.amount_cents > 0 &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0)
);

const septemberInvoices: Array<Invoice & { card_id: number; card_name: string }> = [];
const septemberAllCardTransactions: Array<Transaction & { card_name: string }> = [];
for (const [cardId, cardName] of CARD_NAMES) {
  const cardInvoices = await request<Invoice[]>(
    `/credit_cards/${cardId}/invoices?start_date=2026-09-01&end_date=2026-09-30`
  );
  for (const invoice of cardInvoices) {
    septemberInvoices.push({ ...invoice, card_id: cardId, card_name: cardName });
    const detail = await request<{ transactions?: Transaction[] }>(
      `/credit_cards/${cardId}/invoices/${invoice.id}`
    );
    septemberAllCardTransactions.push(
      ...(detail.transactions || []).map((transaction) => ({ ...transaction, card_name: cardName }))
    );
  }
}

const septemberScheduled = allTransactions.filter((transaction) =>
  transaction.date >= "2026-09-01" &&
  transaction.date <= "2026-09-30" &&
  transaction.paid === false &&
  !transaction.credit_card_id &&
  transaction.amount_cents < 0 &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0)
);
const septemberExpectedIncome = allTransactions.filter((transaction) =>
  transaction.date >= "2026-09-01" &&
  transaction.date <= "2026-09-30" &&
  transaction.paid === false &&
  !transaction.credit_card_id &&
  transaction.amount_cents > 0 &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0)
);

const INCOME_CATEGORIES = new Set([153864764, 113894339, 79404728, 164258372]);
const juneIncome = allTransactions
  .filter((transaction) =>
    transaction.date >= "2026-06-01" &&
    transaction.date <= "2026-06-30" &&
    transaction.amount_cents > 0 &&
    transaction.paid !== false &&
    INCOME_CATEGORIES.has(transaction.category_id || 0)
  )
  .map((transaction) => ({
    id: transaction.id,
    date: transaction.date,
    description: transaction.description,
    amount_cents: transaction.amount_cents,
    category_id: transaction.category_id,
    category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
    account_id: transaction.account_id
  }));

const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
const last30DayInflows = allTransactions
  .filter((transaction) =>
    transaction.date >= "2026-06-26" &&
    transaction.date <= "2026-07-25" &&
    transaction.amount_cents > 0 &&
    transaction.paid !== false &&
    ACCOUNT_IDS.has(transaction.account_id || 0) &&
    !transaction.credit_card_id &&
    !normalize(transaction.description).includes("ajuste")
  )
  .map((transaction) => ({
    id: transaction.id,
    date: transaction.date,
    description: transaction.description,
    amount_cents: transaction.amount_cents,
    category_id: transaction.category_id,
    category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
    account: accountNames.get(transaction.account_id || 0) || `Conta #${transaction.account_id}`
  }))
  .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);

const last30DayExpenses = allTransactions.filter((transaction) =>
  transaction.date >= "2026-06-26" &&
  transaction.date <= "2026-07-25" &&
  transaction.amount_cents < 0 &&
  (Boolean(transaction.credit_card_id) || transaction.paid !== false) &&
  !EXCLUDED_CATEGORIES.has(transaction.category_id || 0) &&
  !normalize(transaction.description).includes("ajuste")
);
const freelanceHistory = allTransactions
  .filter((transaction) =>
    transaction.date >= "2026-05-01" &&
    transaction.date <= "2026-07-25" &&
    transaction.amount_cents > 0 &&
    transaction.paid !== false &&
    [153864764, 113894339].includes(transaction.category_id || 0) &&
    !transaction.credit_card_id
  )
  .map((transaction) => ({
    id: transaction.id,
    date: transaction.date,
    description: transaction.description,
    amount_cents: transaction.amount_cents,
    category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
    account: accountNames.get(transaction.account_id || 0) || `Conta #${transaction.account_id}`
  }))
  .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
const last30DayCategoryExpenses = new Map<number, number>();
for (const transaction of last30DayExpenses) {
  const categoryId = transaction.category_id || 0;
  last30DayCategoryExpenses.set(
    categoryId,
    (last30DayCategoryExpenses.get(categoryId) || 0) + Math.abs(transaction.amount_cents)
  );
}

function effectiveCategoryExpenses(startDate: string, endDate: string) {
  const totals = new Map<number, number>();
  for (const transaction of allTransactions.filter((candidate) =>
    candidate.date >= startDate &&
    candidate.date <= endDate &&
    candidate.amount_cents < 0 &&
    (Boolean(candidate.credit_card_id) || candidate.paid !== false) &&
    !NON_EFFECTIVE_EXPENSE_CATEGORIES.has(candidate.category_id || 0) &&
    !normalize(candidate.description).includes("ajuste")
  )) {
    const categoryId = transaction.category_id || 0;
    totals.set(categoryId, (totals.get(categoryId) || 0) + Math.abs(transaction.amount_cents));
  }
  return [...totals.entries()]
    .map(([categoryId, amountCents]) => ({
      category_id: categoryId,
      category: categoryNames.get(categoryId) || "Sem categoria",
      amount_cents: amountCents
    }))
    .sort((left, right) => right.amount_cents - left.amount_cents);
}

function effectiveExpenseDetails(startDate: string, endDate: string) {
  return allTransactions
    .filter((candidate) =>
      candidate.date >= startDate &&
      candidate.date <= endDate &&
      candidate.amount_cents < 0 &&
      (Boolean(candidate.credit_card_id) || candidate.paid !== false) &&
      !NON_EFFECTIVE_EXPENSE_CATEGORIES.has(candidate.category_id || 0) &&
      !normalize(candidate.description).includes("ajuste")
    )
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria"
    }));
}

console.log(JSON.stringify({
  account_balances: accounts
    .filter((account) => ACCOUNT_IDS.has(account.id))
    .map((account) => ({
      id: account.id,
      name: account.name,
      balance_cents: account.balance_cents,
      balance: account.balance
    })),
  duplicate_candidates: duplicateCandidates,
  detran_duda_entries: allTransactions
    .filter((transaction) => [9485, 9486, -9485, -9486].includes(transaction.amount_cents))
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      paid: transaction.paid,
      category_id: transaction.category_id,
      account_id: transaction.account_id,
      notes: transaction.notes
    })),
  pague_menos_entries: allTransactions
    .filter((transaction) => normalize(transaction.description).includes("pague menos"))
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      credit_card_id: transaction.credit_card_id,
      credit_card_invoice_id: transaction.credit_card_invoice_id,
      notes: transaction.notes
    })),
  balao_entries: allTransactions
    .filter((transaction) => normalize(transaction.description).includes("balao ap"))
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      paid: transaction.paid,
      category_id: transaction.category_id,
      account_id: transaction.account_id,
      notes: transaction.notes
    })),
  aruana_entries: allTransactions
    .filter((transaction) => normalize(transaction.description).includes("aruana"))
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      paid: transaction.paid,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      account_id: transaction.account_id,
      notes: transaction.notes
    })),
  june_income: juneIncome,
  last_30_day_inflows: last30DayInflows,
  freelance_history: freelanceHistory,
  last_30_day_category_expenses: [...last30DayCategoryExpenses.entries()]
    .map(([categoryId, amountCents]) => ({
      category_id: categoryId,
      category: categoryNames.get(categoryId) || "Sem categoria",
      amount_cents: amountCents
    }))
    .sort((left, right) => right.amount_cents - left.amount_cents),
  effective_spending_by_month: {
    june: effectiveCategoryExpenses("2026-06-01", "2026-06-30"),
    july: effectiveCategoryExpenses("2026-07-01", "2026-07-31")
  },
  effective_spending_details: {
    june: effectiveExpenseDetails("2026-06-01", "2026-06-30"),
    july: effectiveExpenseDetails("2026-07-01", "2026-07-31")
  },
  july: {
    paid_account_transactions: july
      .filter((transaction) => transaction.paid !== false && !transaction.credit_card_id)
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        description: transaction.description,
        amount_cents: transaction.amount_cents,
        category_id: transaction.category_id,
        category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
        account_id: transaction.account_id
      })),
    pending_accounts: july
      .filter((transaction) => transaction.paid === false && !transaction.credit_card_id)
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        description: transaction.description,
        amount_cents: transaction.amount_cents,
        category_id: transaction.category_id,
        category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
        account_id: transaction.account_id
      })),
    category_expenses: [...categoryTotals.entries()]
      .map(([categoryId, amountCents]) => ({
        category_id: categoryId,
        category: categoryNames.get(categoryId) || "Sem categoria",
        amount_cents: amountCents
      }))
      .sort((left, right) => right.amount_cents - left.amount_cents),
    gross_expenses_cents: sum(julyExpenses.map((transaction) => Math.abs(transaction.amount_cents))),
    personal_expenses_cents: sum(
      julyExpenses
        .filter((transaction) => !THIRD_PARTY_CATEGORIES.has(transaction.category_id || 0))
        .map((transaction) => Math.abs(transaction.amount_cents))
    ),
    account_cashflow: {
      inflow_cents: sum(accountCashflow.filter((transaction) => transaction.amount_cents > 0).map((transaction) => transaction.amount_cents)),
      outflow_cents: sum(accountCashflow.filter((transaction) => transaction.amount_cents < 0).map((transaction) => Math.abs(transaction.amount_cents)))
    },
    operational_cashflow: {
      inflow_cents: sum(operationalCashflow.filter((transaction) => transaction.amount_cents > 0).map((transaction) => transaction.amount_cents)),
      outflow_cents: sum(operationalCashflow.filter((transaction) => transaction.amount_cents < 0).map((transaction) => Math.abs(transaction.amount_cents)))
    }
  },
  august: {
    personal_card_transactions: augustAllCardTransactions
      .filter((transaction) => !THIRD_PARTY_CATEGORIES.has(transaction.category_id || 0))
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        description: transaction.description,
        amount_cents: transaction.amount_cents,
        category_id: transaction.category_id,
        category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
        card: transaction.card_name,
        notes: transaction.notes
      })),
    duda_and_grandmother_card_transactions: augustThirdPartyCardTransactions.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      card: transaction.card_name,
      notes: transaction.notes
    })),
    invoices: invoices.map((invoice) => ({
      card_id: invoice.card_id,
      card: invoice.card_name,
      invoice_id: invoice.id,
      date: invoice.date,
      balance_cents: invoice.balance_cents,
      amount_cents: invoice.amount_cents,
      previous_balance_cents: invoice.previous_balance_cents
    })),
    scheduled_accounts: augustScheduled.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      account_id: transaction.account_id
    })),
    expected_income: augustExpectedIncome.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      account_id: transaction.account_id
    }))
  },
  september: {
    invoices: septemberInvoices.map((invoice) => ({
      card_id: invoice.card_id,
      card: invoice.card_name,
      invoice_id: invoice.id,
      date: invoice.date,
      balance_cents: invoice.balance_cents,
      amount_cents: invoice.amount_cents,
      previous_balance_cents: invoice.previous_balance_cents
    })),
    card_transactions: septemberAllCardTransactions.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      card: transaction.card_name,
      third_party: THIRD_PARTY_CATEGORIES.has(transaction.category_id || 0)
    })),
    scheduled_accounts: septemberScheduled.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      account_id: transaction.account_id
    })),
    expected_income: septemberExpectedIncome.map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      category_id: transaction.category_id,
      category: categoryNames.get(transaction.category_id || 0) || "Sem categoria",
      account_id: transaction.account_id
    }))
  }
}, null, 2));
