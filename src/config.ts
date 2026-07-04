import dotenv from "dotenv";

dotenv.config();

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function required(name: string, fallbackName?: string): string {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
  if (!value || value.trim().length === 0) {
    const expected = fallbackName ? `${name} or ${fallbackName}` : name;
    throw new Error(`Missing required env var: ${expected}`);
  }
  return value.trim();
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramHandlerTimeoutMs: optionalNumber(process.env.TELEGRAM_HANDLER_TIMEOUT_MS) ?? 300_000,
  allowedTelegramUserIds: optionalNumberList(process.env.ALLOWED_TELEGRAM_USER_IDS),
  databasePath: process.env.DATABASE_PATH?.trim() || "./data/bot-financas.sqlite",
  confidenceThreshold: optionalNumber(process.env.CONFIDENCE_THRESHOLD) ?? 0.85,
  catalogRefreshMinutes: optionalNumber(process.env.CATALOG_REFRESH_MINUTES) ?? 60,
  defaults: {
    accountId: optionalNumber(process.env.DEFAULT_ACCOUNT_ID),
    creditCardId: optionalNumber(process.env.DEFAULT_CREDIT_CARD_ID),
    categoryId: optionalNumber(process.env.DEFAULT_CATEGORY_ID)
  },
  financeBackend: (process.env.FINANCE_BACKEND?.trim().toLowerCase() || "organizze") as "organizze" | "fincontrol",
  organizze: process.env.FINANCE_BACKEND?.trim().toLowerCase() === "fincontrol"
    ? { email: "", token: "", baseUrl: "", userAgent: "" }
    : {
        email: required("ORGANIZZE_EMAIL"),
        token: required("ORGANIZZE_TOKEN", "ORGANIZZE_API_KEY"),
        baseUrl: process.env.ORGANIZZE_BASE_URL?.trim() || "https://api.organizze.com.br/rest/v2",
        userAgent: required("ORGANIZZE_USER_AGENT")
      },
  fincontrol: {
    baseUrl: process.env.FINCONTROL_API_URL?.trim() || "http://localhost:5068/api",
    email: process.env.FINCONTROL_EMAIL?.trim() || "",
    password: process.env.FINCONTROL_PASSWORD?.trim() || ""
  },
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY?.trim(),
    textModel: process.env.OPENROUTER_TEXT_MODEL?.trim() || "qwen/qwen3-30b-a3b-instruct-2507",
    pdfModel: process.env.OPENROUTER_PDF_MODEL?.trim() || "google/gemini-2.5-flash-lite",
    visionModel: process.env.OPENROUTER_VISION_MODEL?.trim() || "google/gemini-2.5-flash-lite",
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL?.trim() || "qwen/qwen2.5-vl-72b-instruct",
    pdfEngine: process.env.OPENROUTER_PDF_ENGINE?.trim() || "cloudflare-ai",
    requestTimeoutMs: optionalNumber(process.env.OPENROUTER_REQUEST_TIMEOUT_MS) ?? 45_000,
    pdfFallbackEngines: (process.env.OPENROUTER_PDF_FALLBACK_ENGINES?.trim() || "native,mistral-ocr")
      .split(",")
      .map((engine) => engine.trim())
      .filter(Boolean)
  },
  transcription: {
    provider: process.env.TRANSCRIPTION_PROVIDER?.trim() || "openrouter",
    openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim(),
    openRouterModel: process.env.OPENROUTER_TRANSCRIPTION_MODEL?.trim() || "openai/whisper-large-v3-turbo",
    openAiApiKey: process.env.OPENAI_API_KEY?.trim(),
    openAiModel: process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe",
    requestTimeoutMs: optionalNumber(process.env.TRANSCRIPTION_REQUEST_TIMEOUT_MS) ?? 75_000,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg"
  }
} as const;
