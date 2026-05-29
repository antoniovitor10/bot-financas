export function parseAmountToCents(input: string): number | undefined {
  input = input.replace(/\u2212/g, "-");
  const amountPattern = "[+-]?(?:(?:\\d{1,3}(?:\\.\\d{3})+)|\\d+)(?:[,.]\\d{1,2})?";
  const decimalPattern = "[+-]?(?:(?:\\d{1,3}(?:\\.\\d{3})+)|\\d+)[,.]\\d{1,2}";
  const patterns = [
    new RegExp(`r\\$\\s*(${amountPattern})`, "i"),
    new RegExp(`(^|[^\\d/])(${amountPattern})\\s*(?:reais|real|brl)\\b`, "i"),
    new RegExp(`(^|[^\\d/])(${decimalPattern})(?!\\d)`, "i")
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return normalizeAmount(match.at(-1) as string);
  }

  const bareNumber = findBareAmount(input);
  return bareNumber ? normalizeAmount(bareNumber) : undefined;
}

function normalizeAmount(raw: string): number | undefined {
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return undefined;

  return Math.round(amount * 100);
}

function findBareAmount(input: string): string | undefined {
  const candidates = input.matchAll(/\b\d+\b/g);
  for (const candidate of candidates) {
    const value = candidate[0];
    const index = candidate.index ?? 0;
    const before = input.slice(Math.max(0, index - 6), index).toLowerCase();
    const after = input.slice(index + value.length, index + value.length + 2).toLowerCase();
    const dateLike = before.includes("dia ") || before.endsWith("/") || after.startsWith("/") || value.length === 4;
    const installmentLike = after.trimStart().startsWith("x");
    if (!dateLike && !installmentLike) return value;
  }
  return undefined;
}

export function formatBRL(amountCents?: number): string {
  if (amountCents === undefined) return "nao identificado";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(amountCents / 100);
}

export function signedAmount(type: "expense" | "income", amountCents: number): number {
  const absolute = Math.abs(amountCents);
  return type === "expense" ? -absolute : absolute;
}
