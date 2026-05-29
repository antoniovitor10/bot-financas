const MONTHS: Record<string, number> = {
  janeiro: 1,
  jan: 1,
  fevereiro: 2,
  fev: 2,
  marco: 3,
  março: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  maio: 5,
  mai: 5,
  junho: 6,
  jun: 6,
  julho: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  setembro: 9,
  set: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  nov: 11,
  dezembro: 12,
  dez: 12
};

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function addDaysIso(dateIso: string, days: number): string {
  return toIsoDate(addDays(new Date(`${dateIso}T00:00:00`), days));
}

export function currentMonthRange(reference = new Date()): { start: string; end: string } {
  return {
    start: toIsoDate(new Date(reference.getFullYear(), reference.getMonth(), 1)),
    end: toIsoDate(new Date(reference.getFullYear(), reference.getMonth() + 1, 0))
  };
}

export function parseDatePt(input: string, reference = new Date()): string | undefined {
  const text = input.toLowerCase();
  if (/\bhoje\b/.test(text)) return toIsoDate(reference);
  if (/\bontem\b/.test(text)) return toIsoDate(addDays(reference, -1));
  if (/\bamanh[aã]\b/.test(text)) return toIsoDate(addDays(reference, 1));

  const iso = text.match(/\b(20\d{2})-(0?[1-9]|1[0-2])-([0-2]?\d|3[01])\b/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }

  const numeric = text.match(/\b([0-2]?\d|3[01])\/(0?[1-9]|1[0-2])(?:\/(20\d{2}|\d{2}))?\b/);
  if (numeric) {
    const year = numeric[3]
      ? numeric[3].length === 2
        ? `20${numeric[3]}`
        : numeric[3]
      : String(reference.getFullYear());
    return `${year}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  }

  const namedMonth = text.match(/\b(?:dia\s*)?([0-2]?\d|3[01])\s+(?:de\s+)?([a-zçã]+)(?:\s+(?:de\s+)?(20\d{2}))?\b/i);
  if (namedMonth) {
    const month = MONTHS[namedMonth[2]];
    if (month) {
      const year = namedMonth[3] || String(reference.getFullYear());
      return `${year}-${String(month).padStart(2, "0")}-${namedMonth[1].padStart(2, "0")}`;
    }
  }

  const dayOnly = text.match(/\bdia\s+([0-2]?\d|3[01])\b/);
  if (dayOnly) {
    return `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, "0")}-${dayOnly[1].padStart(2, "0")}`;
  }

  return undefined;
}

export function ofxDateToIso(value: string): string | undefined {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
