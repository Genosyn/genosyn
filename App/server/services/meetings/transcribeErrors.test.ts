import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { transcribeAudio } from "./transcribe.js";

/**
 * What a meeting page says when the transcription endpoint refuses the audio.
 * The sentence lands in front of a Member, so it has to name the fix.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = {
  target: { baseURL: "http://whisper.invalid/v1", apiKey: "", model: "whisper-1" },
  bytes: Buffer.from("webm-opus-audio"),
  filename: "meeting.webm",
  mime: "audio/webm",
};

function respondWith(body: string, status: number): void {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

test("an endpoint without a speech-to-text route says what to change", async () => {
  // What vLLM answers when it serves one chat model and nothing else. Passed
  // through bare, `{"detail":"Not Found"}` was the whole explanation.
  respondWith('{"detail":"Not Found"}', 404);

  await assert.rejects(
    transcribeAudio(request),
    /no speech-to-text route, or no model named "whisper-1"\. Point the notetaker at a Whisper-compatible server or an OpenAI model/,
  );
});

test("any other refusal keeps the provider's own words", async () => {
  respondWith("quota exceeded", 429);

  await assert.rejects(transcribeAudio(request), /^Error: Transcription failed \(429\): quota exceeded$/);
});
