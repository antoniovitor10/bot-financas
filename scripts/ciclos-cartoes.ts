/**
 * Ciclos reais das faturas que nao batem com o fechamento cadastrado no Organizze (mudancas de vencimento em out/2026).
 * Chave: nome do cartao no Organizze. "vence" e a data da fatura no Organizze; "venceReal" e a data em que o banco cobrou.
 * Itens do Organizze dentro de inicio..fim foram movidos para essa fatura em 25/10/2026 (PUT credit_card_invoice_id);
 * a rotina diaria usa faturaRealPara() para fazer o mesmo com itens novos.
 */
export interface CicloReal { vence: string; venceReal?: string; inicio: string; fim: string }

export const CICLOS_REAIS: Record<string, CicloReal[]> = {
  "pic pay": [
    { vence: "2026-08-15", venceReal: "2026-08-05", inicio: "2026-06-29", fim: "2026-07-28" },
    { vence: "2026-09-15", venceReal: "2026-09-05", inicio: "2026-07-29", fim: "2026-08-28" },
    { vence: "2026-10-15", venceReal: "2026-10-05", inicio: "2026-08-29", fim: "2026-09-29" },
    { vence: "2026-11-15", inicio: "2026-09-30", fim: "2026-11-08" },
    { vence: "2026-12-15", inicio: "2026-11-09", fim: "2026-12-08" },
    { vence: "2027-01-15", inicio: "2026-12-09", fim: "2027-01-08" },
    { vence: "2027-02-15", inicio: "2027-01-09", fim: "2027-02-08" },
    { vence: "2027-03-15", inicio: "2027-02-09", fim: "2027-03-08" }
  ],
  "nu bank": [
    { vence: "2026-08-17", venceReal: "2026-08-05", inicio: "2026-06-29", fim: "2026-07-28" },
    { vence: "2026-09-17", venceReal: "2026-09-05", inicio: "2026-07-29", fim: "2026-08-27" },
    { vence: "2026-10-17", venceReal: "2026-10-05", inicio: "2026-08-28", fim: "2026-09-25" },
    { vence: "2026-11-17", inicio: "2026-09-26", fim: "2026-11-10" }
  ],
  "mercado pago": [
    { vence: "2026-08-04", venceReal: "2026-09-04", inicio: "2026-07-16", fim: "2026-08-15" },
    { vence: "2026-09-04", venceReal: "2026-10-04", inicio: "2026-08-16", fim: "2026-09-15" },
    { vence: "2026-11-04", inicio: "2026-09-16", fim: "2026-10-29" }
  ]
};

/** Data da fatura (no Organizze) em que um item desse cartao, nessa data, deve ficar; undefined = deixar o Organizze decidir. */
export function faturaRealPara(cardName: string, date: string): string | undefined {
  const ciclos = CICLOS_REAIS[cardName.trim()];
  return ciclos?.find((c) => date >= c.inicio && date <= c.fim)?.vence;
}

/** Ciclo real de uma fatura do Organizze, se houver correcao cadastrada. */
export function cicloReal(cardName: string, vence: string): CicloReal | undefined {
  return CICLOS_REAIS[cardName.trim()]?.find((c) => c.vence === vence);
}
