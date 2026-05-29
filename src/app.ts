import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { openDatabase } from "./repositories/db.js";
import { AliasesRepo } from "./repositories/aliases-repo.js";
import { LearningRepo } from "./repositories/learning-repo.js";
import { PendingRepo } from "./repositories/pending-repo.js";
import { TextParser } from "./parsers/text-parser.js";
import { MultiTextParser } from "./parsers/multi-text-parser.js";
import { VoiceParser } from "./parsers/voice-parser.js";
import { LoanParser } from "./parsers/loan-parser.js";
import { OrganizzeApiService } from "./services/organizze-api.js";
import { Categorizer } from "./services/categorizer.js";
import { ConfirmationService } from "./services/confirmation.js";
import { TranscriptionService } from "./services/transcription.js";
import type { ImportService } from "./services/import-service.js";
import { OpenRouterImportService } from "./services/openrouter-import.js";
import { registerTextHandlers } from "./bot/handlers/text.js";
import { registerVoiceHandlers } from "./bot/handlers/voice.js";
import { registerDocumentHandlers } from "./bot/handlers/document.js";
import { registerCallbackHandlers } from "./bot/handlers/callback.js";
import { logger } from "./utils/logger.js";

const db = openDatabase(config.databasePath);
const aliasesRepo = new AliasesRepo(db);
const learningRepo = new LearningRepo(db);
const pendingRepo = new PendingRepo(db);
aliasesRepo.migrate();
learningRepo.migrate();
pendingRepo.migrate();

const organizzeApi = new OrganizzeApiService(config.organizze);
const textParser = new TextParser();
const multiTextParser = new MultiTextParser(textParser);
const loanParser = new LoanParser();
const transcription = new TranscriptionService(config.transcription);
const voiceParser = new VoiceParser(transcription, textParser);
const categorizer = new Categorizer(aliasesRepo, config.defaults, learningRepo);
const confirmation = new ConfirmationService(pendingRepo, organizzeApi, config.confidenceThreshold, learningRepo);
const openRouterImport = new OpenRouterImportService({
  apiKey: config.openRouter.apiKey,
  textModel: config.openRouter.textModel,
  pdfModel: config.openRouter.pdfModel,
  visionModel: config.openRouter.visionModel,
  pdfEngine: config.openRouter.pdfEngine,
  pdfFallbackEngines: config.openRouter.pdfFallbackEngines,
  requestTimeoutMs: config.openRouter.requestTimeoutMs
});
let importServicePromise: Promise<ImportService> | undefined;

function getImportService(): Promise<ImportService> {
  importServicePromise ??= import("./services/import-service.js").then(({ ImportService }) => (
    new ImportService(pendingRepo, organizzeApi, categorizer, openRouterImport)
  ));
  return importServicePromise;
}

const importService: Pick<ImportService, "createOfxBatch" | "createCsvBatch" | "createPdfBatch" | "createImageBatch"> = {
  async createOfxBatch(input) {
    return (await getImportService()).createOfxBatch(input);
  },
  async createCsvBatch(input) {
    return (await getImportService()).createCsvBatch(input);
  },
  async createPdfBatch(input) {
    return (await getImportService()).createPdfBatch(input);
  },
  async createImageBatch(input) {
    return (await getImportService()).createImageBatch(input);
  }
};

async function syncCatalog(): Promise<void> {
  const catalog = await organizzeApi.getCatalog();
  aliasesRepo.syncCatalog(catalog);
  logger.info("Organizze catalog synced", {
    accounts: catalog.accounts.length,
    categories: catalog.categories.length,
    creditCards: catalog.creditCards.length
  });
}

const bot = new Telegraf(config.telegramBotToken, {
  handlerTimeout: config.telegramHandlerTimeoutMs
});

bot.use(async (ctx, next) => {
  if (config.allowedTelegramUserIds.length === 0) {
    await next();
    return;
  }

  const userId = ctx.from?.id;
  if (!userId || !config.allowedTelegramUserIds.includes(userId)) {
    logger.warn("Blocked unauthorized Telegram update", {
      userId,
      updateType: ctx.updateType
    });
    return;
  }

  await next();
});

bot.catch((error) => {
  logger.error("Unhandled Telegram bot error", { error: (error as Error).message });
});

registerCallbackHandlers(bot, {
  confirmation,
  pendingRepo,
  organizzeApi,
  aliasesRepo,
  learningRepo,
  categorizer,
  syncCatalog
});
registerTextHandlers(bot, {
  textParser,
  loanParser,
  categorizer,
  confirmation,
  aliasesRepo,
  learningRepo,
  pendingRepo,
  organizzeApi,
  syncCatalog
});
registerVoiceHandlers(bot, { voiceParser, multiTextParser, loanParser, openRouterImport, categorizer, confirmation });
registerDocumentHandlers(bot, { importService });

await syncCatalog().catch((error) => {
  logger.error("Initial catalog sync failed", { error: (error as Error).message });
});

setInterval(
  () => {
    syncCatalog().catch((error) => {
      logger.error("Scheduled catalog sync failed", { error: (error as Error).message });
    });
  },
  config.catalogRefreshMinutes * 60 * 1000
).unref();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

await bot.launch();
logger.info("Telegram finance bot started");
