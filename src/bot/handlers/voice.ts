import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Categorizer } from "../../services/categorizer.js";
import type { ConfirmationService } from "../../services/confirmation.js";
import type { VoiceParser } from "../../parsers/voice-parser.js";
import type { MultiTextParser } from "../../parsers/multi-text-parser.js";
import { amountLooksPresent, countAmounts } from "../../parsers/multi-text-parser.js";
import type { LoanParser } from "../../parsers/loan-parser.js";
import type { OpenRouterImportService } from "../../services/openrouter-import.js";
import { logger } from "../../utils/logger.js";

interface VoiceHandlerDeps {
  voiceParser: VoiceParser;
  multiTextParser: MultiTextParser;
  loanParser: LoanParser;
  openRouterImport: OpenRouterImportService;
  categorizer: Categorizer;
  confirmation: ConfirmationService;
}

export function registerVoiceHandlers(bot: Telegraf, deps: VoiceHandlerDeps): void {
  bot.on(message("voice"), async (ctx) => {
    await ctx.reply("Recebi o audio. Vou transcrever e te mandar para revisao.");
    void processVoice(ctx, ctx.message.voice.file_id, ctx.message.voice.mime_type, deps);
  });

  bot.on(message("audio"), async (ctx) => {
    await ctx.reply("Recebi o audio. Vou transcrever e te mandar para revisao.");
    void processVoice(ctx, ctx.message.audio.file_id, ctx.message.audio.mime_type, deps);
  });
}

async function processVoice(ctx: Context, fileId: string, mimeType: string | undefined, deps: VoiceHandlerDeps): Promise<void> {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    await handleAudio(link.href, mimeType, ctx, deps);
  } catch (error) {
    logger.error("Voice handler failed", { error: (error as Error).message });
    await ctx.reply(`Nao consegui processar o audio: ${(error as Error).message}`);
  }
}

async function handleAudio(fileUrl: string, mimeType: string | undefined, ctx: Context, deps: VoiceHandlerDeps): Promise<void> {
  const transcript = await deps.voiceParser.transcribeTelegramFile(fileUrl, mimeType);
  const loan = deps.loanParser.parse(transcript, "voice");
  if (loan) {
    await deps.confirmation.askBundle(ctx, {
      ...loan,
      transactions: loan.transactions.map((transaction) => deps.categorizer.enrich(transaction))
    });
    return;
  }

  let parsed;
  try {
    parsed = await deps.openRouterImport.extractText(transcript, "voice");
  } catch (error) {
    logger.error("Voice multi-transaction extraction failed", { error: (error as Error).message });
    parsed = [deps.voiceParser.fromTranscript(transcript)];
  }
  const localParts = deps.multiTextParser.parse(transcript, "voice");
  const amountCount = countAmounts(transcript);
  const suspicious = amountCount > parsed.length || parsed.some((transaction) => !amountLooksPresent(transcript, transaction.amount_cents));
  if (localParts.length > 0 && suspicious) {
    logger.info("Using local multi-transaction split for voice", {
      transcript,
      amountCount,
      modelTransactions: parsed.length,
      localTransactions: localParts.length
    });
    parsed = localParts;
  }
  if (parsed.length === 0) {
    parsed = [deps.voiceParser.fromTranscript(transcript)];
  }

  for (const transaction of parsed) {
    const enriched = deps.categorizer.enrich({
      ...transaction,
      source: "voice",
      raw_text: transaction.raw_text || transcript,
      notes: transaction.notes || `Transcrito de audio: ${transcript}`
    });
    await deps.confirmation.ask(ctx, enriched);
  }
}
