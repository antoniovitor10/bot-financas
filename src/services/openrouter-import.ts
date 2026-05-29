import type { ParsedTransaction, Periodicity, TransactionSource } from "../types/finance.js";

export interface OpenRouterImportOptions {
  apiKey?: string;
  textModel: string;
  pdfModel: string;
  visionModel: string;
  pdfEngine: string;
  pdfFallbackEngines: string[];
  requestTimeoutMs: number;
}

interface ExtractedTransaction {
  type?: "expense" | "income";
  description?: string;
  amount_cents?: number;
  date?: string;
  category_hint?: string;
  account_hint?: string;
  credit_card_hint?: string;
  paid?: boolean;
  installments_current?: number;
  installments_total?: number;
  recurrence_periodicity?: string;
  notes?: string;
  confidence?: number;
}

interface ExtractedPayload {
  transactions?: ExtractedTransaction[];
}

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["expense", "income"] },
          description: { type: "string" },
          amount_cents: { type: "integer" },
          date: { type: "string", description: "YYYY-MM-DD" },
          category_hint: { type: "string" },
          account_hint: { type: "string" },
          credit_card_hint: { type: "string" },
          paid: { type: "boolean" },
          installments_current: { type: "integer" },
          installments_total: { type: "integer" },
          recurrence_periodicity: { type: "string", enum: ["", "monthly", "yearly", "weekly", "biweekly", "bimonthly", "trimonthly"] },
          notes: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["type", "description", "amount_cents", "date", "category_hint", "account_hint", "credit_card_hint", "paid", "installments_current", "installments_total", "recurrence_periodicity", "notes", "confidence"]
      }
    }
  },
  required: ["transactions"]
};

const PROMPT = [
  "Extraia lançamentos financeiros de fatura, extrato, comprovante ou imagem.",
  "Retorne apenas transações reais, ignorando totais, limites, saldos, propagandas, juros futuros e linhas duplicadas.",
  "amount_cents deve estar em centavos. Despesas devem ser negativas; receitas positivas.",
  "date deve ser YYYY-MM-DD. Se o ano não estiver claro, use o ano mais provável do documento.",
  "Use category_hint, account_hint e credit_card_hint com nomes vistos no documento, ou string vazia.",
  "paid deve ser true para lancamento ja pago/efetivado e false para conta, fatura ou boleto a vencer.",
  "Para compra parcelada, preencha installments_total; caso contrário 0.",
  "Para recorrência, use recurrence_periodicity; caso contrário string vazia.",
  "confidence deve ir de 0 a 1."
].join("\n");

const IMPORT_PROMPT = [
  "Extraia TODOS os lancamentos financeiros de fatura, extrato, comprovante ou imagem.",
  "Nao resuma e nao limite a quantidade: cada linha de compra, parcela, estorno, pagamento, ajuste, IOF, juros ou tarifa deve virar uma transacao separada.",
  "Retorne apenas transacoes reais, ignorando totais, subtotais, limite disponivel, saldo anterior, saldo atual, codigo de barras, propagandas e linhas duplicadas.",
  "Em fatura de cartao, inclua compras a vista e compras parceladas que aparecem na fatura atual. Nao invente parcelas futuras que nao aparecem no documento.",
  "amount_cents deve estar em centavos. Despesas devem ser negativas; receitas positivas.",
  "date deve ser YYYY-MM-DD. Se o ano nao estiver claro, use o ano mais provavel do documento.",
  "Use category_hint, account_hint e credit_card_hint com nomes vistos no documento, ou string vazia.",
  "paid deve ser true para lancamento ja pago/efetivado e false para conta, fatura ou boleto a vencer.",
  "Para compra parcelada, preencha installments_total com o total do marcador 3/10, 4/4 etc.; caso contrario 0.",
  "Para recorrencia, use recurrence_periodicity; caso contrario string vazia.",
  "confidence deve ir de 0 a 1."
].join("\n");

const TEXT_PROMPT = [
  "Extraia TODOS os lancamentos financeiros do texto transcrito abaixo.",
  "O texto pode conter uma ou varias transacoes ditadas em linguagem natural.",
  "Nao junte transacoes diferentes. Cada compra, receita, conta a vencer, fatura, boleto ou ajuste deve virar uma transacao separada.",
  "amount_cents deve estar em centavos. Despesas devem ser negativas; receitas positivas.",
  "date deve ser YYYY-MM-DD. Se faltar data, use hoje.",
  "Use category_hint, account_hint e credit_card_hint com nomes citados no texto, ou string vazia.",
  "paid deve ser true para lancamento ja pago/efetivado e false para conta, fatura ou boleto a vencer.",
  "Para compra parcelada, preencha installments_current e installments_total quando houver marcador ou fala do tipo 2 de 6; caso contrario 0.",
  "Para recorrencia, use recurrence_periodicity; caso contrario string vazia.",
  "confidence deve ir de 0 a 1."
].join("\n");

export class OpenRouterImportService {
  constructor(private readonly options: OpenRouterImportOptions) {}

  async extractPdf(buffer: Buffer, fileName: string): Promise<ParsedTransaction[]> {
    const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;
    const engines = unique([this.options.pdfEngine, ...this.options.pdfFallbackEngines]);
    const errors: string[] = [];

    for (const engine of engines) {
      try {
        return await this.extract({
          model: this.options.pdfModel,
          source: "pdf",
          content: [
            { type: "text", text: `${IMPORT_PROMPT}\n\nPDF engine usado: ${engine}.` },
            { type: "file", file: { filename: fileName, file_data: dataUrl } }
          ],
          plugins: [
            {
              id: "file-parser",
              pdf: { engine }
            }
          ]
        });
      } catch (error) {
        errors.push(`${engine}: ${(error as Error).message}`);
      }
    }

    throw new Error(`Falha ao importar PDF com todos os engines configurados. ${errors.join(" | ")}`);
  }

  async extractImage(buffer: Buffer, mimeType: string): Promise<ParsedTransaction[]> {
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    return this.extract({
      model: this.options.visionModel,
      source: "image",
      content: [
        { type: "text", text: IMPORT_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    });
  }

  async extractText(text: string, source: TransactionSource = "text"): Promise<ParsedTransaction[]> {
    return this.extract({
      model: this.options.textModel,
      source,
      content: [
        { type: "text", text: `${TEXT_PROMPT}\n\nTexto:\n${text}` }
      ]
    });
  }

  private async extract(input: {
    model: string;
    source: TransactionSource;
    content: object[];
    plugins?: object[];
  }): Promise<ParsedTransaction[]> {
    if (!this.options.apiKey) {
      throw new Error("OPENROUTER_API_KEY nao configurada para importar PDF/imagem.");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "user",
            content: input.content
          }
        ],
        plugins: input.plugins,
        provider: {
          require_parameters: true
        },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "finance_import",
            strict: true,
            schema: EXTRACTION_SCHEMA
          }
        },
        stream: false
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Falha no OpenRouter (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter retornou resposta vazia.");

    const parsed = JSON.parse(content) as ExtractedPayload;
    return (parsed.transactions || []).map((transaction) => this.toParsedTransaction(transaction, input.source));
  }

  private toParsedTransaction(transaction: ExtractedTransaction, source: TransactionSource): ParsedTransaction {
    const installmentsTotal = transaction.installments_total || 0;
    const installmentsCurrent = transaction.installments_current || 0;
    const recurrence = transaction.recurrence_periodicity as Periodicity | "";
    const parsed: ParsedTransaction = {
      type: transaction.type || (transaction.amount_cents && transaction.amount_cents > 0 ? "income" : "expense"),
      description: transaction.description,
      amount_cents: transaction.amount_cents,
      date: transaction.date,
      paid: transaction.paid,
      installments: installmentsTotal > 1 ? { total: installmentsTotal, current: installmentsCurrent || undefined, periodicity: "monthly" } : undefined,
      recurrence: recurrence ? { periodicity: recurrence } : undefined,
      notes: transaction.notes,
      confidence: transaction.confidence ?? 0.7,
      missing_fields: [],
      source,
      raw_text: [
        transaction.description,
        transaction.category_hint,
        transaction.account_hint,
        transaction.credit_card_hint,
        transaction.notes
      ].filter(Boolean).join(" ")
    };

    parsed.missing_fields = missingFields(parsed);
    return parsed;
  }
}

function missingFields(transaction: ParsedTransaction): string[] {
  const missing: string[] = [];
  if (!transaction.description) missing.push("description");
  if (transaction.amount_cents === undefined) missing.push("amount_cents");
  if (!transaction.date) missing.push("date");
  return missing;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
