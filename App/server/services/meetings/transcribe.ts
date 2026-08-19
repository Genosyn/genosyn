import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { decryptSecret } from "../../lib/secret.js";
import { assertSafeOutboundUrl } from "../../lib/outboundUrl.js";
import { readCustomEndpoint } from "../customEndpoint.js";
import { getActiveModel } from "../models.js";
import { readRecording } from "./storage.js";
import { replaceTranscript } from "./store.js";

/**
 * Speech → transcript, over the OpenAI audio API shape.
 *
 * **No new credential store and no new dependency.** The endpoint is derived
 * from the notetaker employee's own `AIModel` row, which already holds an
 * encrypted key and, for a `custom` model, a base URL. That gives a
 * self-hoster the outcome they actually want — point the model at a local
 * whisper.cpp or faster-whisper and the audio never leaves the building — for
 * free, because it is the same knob they already turned for the chat model.
 *
 * Anthropic publishes no audio endpoint, so an Anthropic-only employee gets a
 * sentence saying exactly that instead of a 404 from a URL we invented.
 */

/** `verbose_json` gives per-utterance timings; `json` would give one blob. */
const RESPONSE_FORMAT = "verbose_json";

/** Long enough for a 25 MB upload plus the model's own pass over an hour of
 * audio, which is minutes rather than seconds on a local whisper. */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

export type TranscriptionSegment = {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
};

export type TranscriptionTarget = {
  baseURL: string;
  apiKey: string;
  model: string;
};

type ModelConfig = Record<string, unknown>;

function readModelConfig(model: AIModel): ModelConfig {
  try {
    const parsed = JSON.parse(model.configJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ModelConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Where should this employee's audio go?
 *
 * Returns a discriminated result rather than throwing, because "this employee
 * has no model that can transcribe" is an ordinary configuration state the UI
 * has to explain, not an exception.
 */
export async function resolveTranscriptionTarget(
  employeeId: string,
): Promise<{ target: TranscriptionTarget } | { error: string }> {
  const model = await getActiveModel(employeeId);
  if (!model) {
    return { error: "This employee has no AI Model connected, so it cannot transcribe audio." };
  }

  if (model.authMode === "customEndpoint" && model.provider === "custom") {
    const cfg = readCustomEndpoint(model);
    if (!cfg) {
      return { error: "The custom endpoint is not fully configured. Re-enter its base URL." };
    }
    try {
      await assertSafeOutboundUrl(cfg.baseURL);
    } catch (err) {
      return {
        error: `The custom endpoint was blocked: ${
          err instanceof Error ? err.message : "unsafe outbound URL"
        }`,
      };
    }
    return {
      target: {
        baseURL: cfg.baseURL.replace(/\/+$/, ""),
        apiKey: cfg.apiKey ?? "",
        model: config.meetings.transcriptionModel,
      },
    };
  }

  if (model.provider === "openai" && model.authMode === "apikey") {
    const raw = readModelConfig(model).apiKeyEncrypted;
    if (typeof raw !== "string" || !raw) {
      return { error: "The OpenAI model has no stored API key. Reconnect it." };
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(raw);
    } catch {
      return { error: "The OpenAI API key could not be decrypted." };
    }
    return {
      target: {
        baseURL: "https://api.openai.com/v1",
        apiKey,
        model: config.meetings.transcriptionModel,
      },
    };
  }

  if (model.provider === "anthropic") {
    return {
      error:
        "Anthropic models have no speech-to-text endpoint. Give this employee an OpenAI model, or a custom endpoint pointing at a local whisper server, to transcribe recordings.",
    };
  }
  if (model.authMode === "subscription") {
    return {
      error:
        "Subscription models cannot transcribe audio. Connect an API-key or custom-endpoint model for transcription.",
    };
  }
  return { error: `${model.provider} models cannot transcribe audio.` };
}

/**
 * The `verbose_json` payload, defensively.
 *
 * A local whisper server is not obliged to match OpenAI's schema exactly, and
 * plenty return `text` with no `segments` at all. That is a perfectly usable
 * transcript — one segment, no timings — so it is handled rather than rejected.
 */
export function parseTranscriptionResponse(payload: unknown): TranscriptionSegment[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as { text?: unknown; segments?: unknown };

  if (Array.isArray(body.segments) && body.segments.length > 0) {
    const out: TranscriptionSegment[] = [];
    for (const raw of body.segments) {
      if (!raw || typeof raw !== "object") continue;
      const segment = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) continue;
      // OpenAI reports seconds as floats; a local server sometimes reports ms.
      // Seconds is the documented contract, so that is what we read.
      const start = typeof segment.start === "number" ? segment.start : 0;
      const end = typeof segment.end === "number" ? segment.end : start;
      out.push({
        startMs: Math.max(0, Math.round(start * 1000)),
        endMs: Math.max(0, Math.round(end * 1000)),
        speaker: typeof segment.speaker === "string" ? segment.speaker : "",
        text,
      });
    }
    if (out.length > 0) return out;
  }

  const flat = typeof body.text === "string" ? body.text.trim() : "";
  if (!flat) return [];
  return [{ startMs: 0, endMs: 0, speaker: "", text: flat }];
}

/** POST the audio and return parsed segments. Exported for the meeting flow. */
export async function transcribeAudio(args: {
  target: TranscriptionTarget;
  bytes: Buffer;
  filename: string;
  mime: string;
}): Promise<TranscriptionSegment[]> {
  const form = new FormData();
  form.append("model", args.target.model);
  form.append("response_format", RESPONSE_FORMAT);
  form.append(
    "file",
    new Blob([new Uint8Array(args.bytes)], { type: args.mime }),
    args.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${args.target.baseURL}/audio/transcriptions`, {
      method: "POST",
      headers: args.target.apiKey ? { Authorization: `Bearer ${args.target.apiKey}` } : {},
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Transcription timed out after 10 minutes.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return parseTranscriptionResponse(await res.json());
}

/**
 * Transcribe a meeting's stored recording and replace its transcript.
 *
 * Drives `transcriptState` through `running` → `ready` / `failed` so a page
 * that is watching can say something true, and so a crash mid-pass leaves a
 * state a human can see rather than a meeting that looks fine and has no text.
 */
export async function transcribeMeeting(
  companyId: string,
  meetingId: string,
): Promise<{ segments: number } | { error: string }> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: meetingId, companyId });
  if (!meeting) return { error: "Meeting not found." };
  if (!meeting.recordingPath) return { error: "This meeting has no recording to transcribe." };
  if (!meeting.notetakerEmployeeId) {
    return { error: "Assign an AI Employee to this meeting before transcribing it." };
  }

  const resolved = await resolveTranscriptionTarget(meeting.notetakerEmployeeId);
  if ("error" in resolved) {
    await repo.update({ id: meetingId }, { transcriptState: "failed", transcriptError: resolved.error });
    return resolved;
  }

  const bytes = readRecording(meeting.recordingPath);
  if (!bytes) {
    const error = "The stored recording is missing from disk.";
    await repo.update({ id: meetingId }, { transcriptState: "failed", transcriptError: error });
    return { error };
  }

  await repo.update({ id: meetingId }, { transcriptState: "running", transcriptError: "" });
  try {
    const segments = await transcribeAudio({
      target: resolved.target,
      bytes,
      filename: `meeting-${meetingId}`,
      mime: meeting.recordingMime || "audio/mpeg",
    });
    if (segments.length === 0) {
      const error = "The transcription service returned no text.";
      await repo.update({ id: meetingId }, { transcriptState: "failed", transcriptError: error });
      return { error };
    }
    const written = await replaceTranscript({ companyId, meetingId, segments });
    return { segments: written };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await repo.update({ id: meetingId }, { transcriptState: "failed", transcriptError: error });
    return { error };
  }
}
