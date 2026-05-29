import type { ParsedTransaction } from "../types/finance.js";
import type { TextParser } from "./text-parser.js";
import type { TranscriptionService } from "../services/transcription.js";

export class VoiceParser {
  constructor(
    private readonly transcription: TranscriptionService,
    private readonly textParser: TextParser
  ) {}

  async parseTelegramFile(fileUrl: string, mimeType?: string): Promise<ParsedTransaction> {
    const transcript = await this.transcribeTelegramFile(fileUrl, mimeType);
    return this.fromTranscript(transcript);
  }

  async transcribeTelegramFile(fileUrl: string, mimeType?: string): Promise<string> {
    return this.transcription.transcribeFromUrl(fileUrl, mimeType);
  }

  fromTranscript(transcript: string): ParsedTransaction {
    const parsed = this.textParser.parse(transcript);
    return {
      ...parsed,
      source: "voice",
      raw_text: transcript,
      notes: `Transcrito de audio: ${transcript}`
    };
  }
}
