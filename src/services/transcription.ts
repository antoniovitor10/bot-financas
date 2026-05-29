import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface TranscriptionOptions {
  provider: string;
  openRouterApiKey?: string;
  openRouterModel: string;
  openAiApiKey?: string;
  openAiModel: string;
  requestTimeoutMs: number;
  ffmpegPath: string;
}

export class TranscriptionService {
  constructor(private readonly options: TranscriptionOptions) {}

  async transcribeFromUrl(fileUrl: string, mimeType?: string): Promise<string> {
    const response = await fetch(fileUrl, { signal: AbortSignal.timeout(this.options.requestTimeoutMs) });
    if (!response.ok) {
      throw new Error(`Falha ao baixar audio do Telegram: ${response.status} ${response.statusText}`);
    }

    const sourceBuffer = Buffer.from(await response.arrayBuffer());
    const { buffer, filename, contentType, cleanup } = await this.prepareAudio(sourceBuffer, mimeType, this.options.provider);

    try {
      if (this.options.provider === "openrouter") {
        return await this.transcribeWithOpenRouter(buffer, contentType, filename);
      }

      return await this.transcribeWithOpenAi(buffer, contentType, filename);
    } finally {
      await cleanup();
    }
  }

  private async transcribeWithOpenRouter(buffer: Buffer, contentType: string, filename: string): Promise<string> {
    if (!this.options.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY nao configurada para transcrever audio.");
    }

    const transcription = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      headers: {
        Authorization: `Bearer ${this.options.openRouterApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.openRouterModel,
        language: "pt",
        input_audio: {
          data: buffer.toString("base64"),
          format: audioFormat(contentType, filename)
        }
      })
    });

    if (!transcription.ok) {
      const body = await transcription.text();
      throw new Error(`Falha na transcricao OpenRouter: ${transcription.status} ${body}`);
    }

    const json = (await transcription.json()) as { text?: string };
    if (!json.text) throw new Error("Resposta de transcricao sem texto.");
    return json.text;
  }

  private async transcribeWithOpenAi(buffer: Buffer, contentType: string, filename: string): Promise<string> {
    if (!this.options.openAiApiKey) {
      throw new Error("OPENAI_API_KEY nao configurada para transcrever audio.");
    }

    const form = new FormData();
    form.append("model", this.options.openAiModel);
    form.append("language", "pt");
    form.append("response_format", "json");
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    form.append("file", new Blob([arrayBuffer], { type: contentType }), filename);

    const transcription = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      headers: {
        Authorization: `Bearer ${this.options.openAiApiKey}`
      },
      body: form
    });

    if (!transcription.ok) {
      const body = await transcription.text();
      throw new Error(`Falha na transcricao OpenAI: ${transcription.status} ${body}`);
    }

    const json = (await transcription.json()) as { text?: string };
    if (!json.text) throw new Error("Resposta de transcricao sem texto.");
    return json.text;
  }

  private async prepareAudio(sourceBuffer: Buffer, mimeType: string | undefined, provider: string): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
    cleanup: () => Promise<void>;
  }> {
    const isOgg = mimeType?.includes("ogg") || mimeType?.includes("oga");
    if (provider === "openrouter" || isOpenAiSupportedAudio(mimeType)) {
      return {
        buffer: sourceBuffer,
        filename: isOgg ? "audio.ogg" : filenameForMime(mimeType),
        contentType: contentTypeForMime(mimeType),
        cleanup: async () => undefined
      };
    }

    const id = randomUUID();
    const input = join(tmpdir(), `${id}.oga`);
    const output = join(tmpdir(), `${id}.wav`);
    await writeFile(input, sourceBuffer);
    try {
      await execFileAsync(this.options.ffmpegPath, ["-y", "-i", input, "-ar", "16000", "-ac", "1", output]);
      return {
        buffer: await readFile(output),
        filename: "audio.wav",
        contentType: "audio/wav",
        cleanup: async () => {
          await Promise.allSettled([rm(input, { force: true }), rm(output, { force: true })]);
        }
      };
    } catch (error) {
      await Promise.allSettled([rm(input, { force: true }), rm(output, { force: true })]);
      throw new Error(`Falha ao converter audio OGG com ffmpeg: ${(error as Error).message}`);
    }
  }
}

function filenameForMime(mimeType?: string): string {
  const format = audioFormat(mimeType || "audio/webm", "");
  return `audio.${format === "mpeg" ? "mp3" : format}`;
}

function contentTypeForMime(mimeType?: string): string {
  const format = audioFormat(mimeType || "audio/webm", "");
  if (format === "mp3") return "audio/mpeg";
  if (format === "mp4") return "audio/mp4";
  if (format === "m4a") return "audio/mp4";
  if (format === "ogg") return "audio/ogg";
  if (format === "wav") return "audio/wav";
  if (format === "flac") return "audio/flac";
  if (format === "webm") return "audio/webm";
  return mimeType || "audio/webm";
}

function isOpenAiSupportedAudio(mimeType?: string): boolean {
  const format = audioFormat(mimeType || "audio/webm", "");
  return new Set(["flac", "mp3", "mp4", "mpeg", "m4a", "ogg", "wav", "webm"]).has(format);
}

function audioFormat(contentType: string, filename: string): string {
  const source = `${contentType} ${filename}`.toLowerCase();
  if (source.includes("wav")) return "wav";
  if (source.includes("mpeg") || source.includes("mp3")) return "mp3";
  if (source.includes("mp4")) return "mp4";
  if (source.includes("webm")) return "webm";
  if (source.includes("flac")) return "flac";
  if (source.includes("m4a")) return "m4a";
  if (source.includes("aac")) return "aac";
  if (source.includes("ogg") || source.includes("oga")) return "ogg";
  return "wav";
}
