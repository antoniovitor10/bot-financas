import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { ImportService } from "../../services/import-service.js";
import type { ImportBatch } from "../../types/finance.js";
import { batchSummaryKeyboard, renderBatchSummary } from "../../services/import-review.js";
import { logger } from "../../utils/logger.js";

type DocumentImportService = Pick<ImportService, "createOfxBatch" | "createCsvBatch" | "createPdfBatch" | "createImageBatch">;

interface DocumentHandlerDeps {
  importService: DocumentImportService;
}

type ImportKind = "ofx" | "csv" | "pdf" | "image";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function registerDocumentHandlers(bot: Telegraf, deps: DocumentHandlerDeps): void {
  bot.on(message("document"), async (ctx) => {
    const document = ctx.message.document;
    const fileName = document.file_name || "arquivo";
    const kind = detectImportKind(fileName, document.mime_type);

    if (!kind) {
      await ctx.reply("Aceito arquivos .ofx, .csv, .pdf ou imagem de comprovante/fatura.");
      return;
    }

    if (!ctx.chat) return;

    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const batch = await createBatchForKind(deps.importService, {
        kind,
        buffer,
        fileName,
        mimeType: document.mime_type || "application/octet-stream",
        chatId: ctx.chat.id,
        userId: ctx.from?.id
      });

      await ctx.reply(summaryForBatch(batch, kind), batchSummaryKeyboard(batch));
    } catch (error) {
      logger.error("Document handler failed", { error: (error as Error).message });
      await ctx.reply(`Nao consegui importar o arquivo: ${(error as Error).message}`);
    }
  });

  bot.on(message("photo"), async (ctx) => {
    if (!ctx.chat) return;

    try {
      const photo = ctx.message.photo.at(-1);
      if (!photo) {
        await ctx.reply("Nao encontrei a imagem nessa mensagem.");
        return;
      }

      const buffer = await downloadTelegramFile(ctx, photo.file_id);
      const batch = await deps.importService.createImageBatch({
        buffer,
        mimeType: "image/jpeg",
        fileName: `telegram-photo-${photo.file_unique_id}.jpg`,
        chatId: ctx.chat.id,
        userId: ctx.from?.id
      });

      await ctx.reply(summaryForBatch(batch, "image"), batchSummaryKeyboard(batch));
    } catch (error) {
      logger.error("Photo handler failed", { error: (error as Error).message });
      await ctx.reply(`Nao consegui importar a imagem: ${(error as Error).message}`);
    }
  });
}

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.href);
  if (!response.ok) {
    throw new Error(`Falha ao baixar arquivo do Telegram: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function createBatchForKind(importService: DocumentImportService, input: {
  kind: ImportKind;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  chatId: number;
  userId?: number;
}): Promise<ImportBatch> {
  if (input.kind === "ofx") {
    return importService.createOfxBatch({
      content: input.buffer.toString("utf8"),
      fileName: input.fileName,
      chatId: input.chatId,
      userId: input.userId
    });
  }

  if (input.kind === "csv") {
    return importService.createCsvBatch({
      content: input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
      fileName: input.fileName,
      chatId: input.chatId,
      userId: input.userId
    });
  }

  if (input.kind === "pdf") {
    return importService.createPdfBatch({
      buffer: input.buffer,
      fileName: input.fileName,
      chatId: input.chatId,
      userId: input.userId
    });
  }

  return importService.createImageBatch({
    buffer: input.buffer,
    mimeType: input.mimeType,
    fileName: input.fileName,
    chatId: input.chatId,
    userId: input.userId
  });
}

function detectImportKind(fileName: string, mimeType?: string): ImportKind | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ofx")) return "ofx";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || mimeType === "text/csv") return "csv";
  if (lower.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (/\.(jpe?g|png|webp|gif)$/i.test(lower)) return "image";
  return undefined;
}

function summaryForBatch(batch: ImportBatch, kind: ImportKind): string {
  const label = {
    ofx: "OFX",
    csv: "CSV",
    pdf: "PDF",
    image: "imagem"
  }[kind];
  return renderBatchSummary(batch, label);
}
