import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SCENE_COVERAGE_SYSTEM_PROMPT } from "../../packages/story-engine/src/scene-coverage.js";

export type StoryOnlySyntheticResponse = Readonly<{
  content: string;
  finishReason?: "stop" | "length";
  statusCode?: number;
}>;

export function storyOnlyNarrativeResponse(): string {
  return JSON.stringify({
    narration: "A lantern swings above the empty station as the next path opens.",
    choices: ["Follow the lantern.", "Inspect the platform.", "Call into the tunnel.", "Wait for the signal."],
    custom_action_suggestion: "Study the station map.",
    scratchpad: "",
    tracker_updates: [],
    image_prompt: "",
    continuity_summary: "The traveler has reached an empty station.",
    canonical_facts: ["A lantern marks the open path."],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: ["Learn who lit the lantern."]
  });
}

export function storyOnlyCoverageResponse(): string {
  return JSON.stringify({
    covered: true,
    missing_required_beats: [],
    contradictions: []
  });
}

const MAX_COMPLETION_REQUEST_CHARACTERS = 1_000_000;
const normalizedSceneCoverageSystemPrompt = SCENE_COVERAGE_SYSTEM_PROMPT.replace(/\s+/g, " ").trim();

function hasSceneCoverageSystemPrompt(content: string): boolean {
  return content.replace(/\s+/g, " ").trim().startsWith(normalizedSceneCoverageSystemPrompt);
}

function isSceneCoverageRequest(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { response_format?: unknown; messages?: unknown };
    const responseFormat = payload.response_format;
    if (responseFormat !== null && typeof responseFormat === "object"
      && (responseFormat as { json_schema?: unknown }).json_schema !== null
      && typeof (responseFormat as { json_schema?: unknown }).json_schema === "object"
      && (responseFormat as { json_schema: { name?: unknown } }).json_schema.name === "scene_coverage") return true;
    if (!Array.isArray(payload.messages)) return false;
    return payload.messages.some((message) => message !== null && typeof message === "object"
      && (message as { role?: unknown }).role === "system"
      && typeof (message as { content?: unknown }).content === "string"
      && hasSceneCoverageSystemPrompt((message as { content: string }).content));
  } catch {
    return false;
  }
}

function eventCoverageResponse(body: string): string | null {
  try {
    const payload = JSON.parse(body) as { messages?: unknown };
    if (!isSceneCoverageRequest(body) || !Array.isArray(payload.messages)) return null;
    for (const message of payload.messages) {
      if (message === null || typeof message !== "object"
        || (message as { role?: unknown }).role !== "user"
        || typeof (message as { content?: unknown }).content !== "string") continue;
      const prompt = JSON.parse((message as { content: string }).content) as { required_events?: unknown };
      if (!Array.isArray(prompt.required_events)) continue;
      const eventIds = prompt.required_events.map((event) => event !== null && typeof event === "object"
        && typeof (event as { event_id?: unknown }).event_id === "string"
        && (event as { event_id: string }).event_id.trim().length > 0
        && typeof (event as { fiction_requirement?: unknown }).fiction_requirement === "string"
        ? (event as { event_id: string }).event_id
        : null);
      if (eventIds.some((eventId) => eventId === null)) return null;
      return JSON.stringify({
        event_results: eventIds.map((eventId) => ({
          event_id: eventId,
          covered: true,
          missing_required_beats: [],
          contradictions: []
        }))
      });
    }
  } catch {
    return null;
  }
  return null;
}

function coverageFallback(body: string): string | null {
  if (!isSceneCoverageRequest(body)) return null;
  return eventCoverageResponse(body) ?? storyOnlyCoverageResponse();
}

export type StoryOnlySyntheticProvider = Readonly<{
  baseUrl: string;
  enqueue(response: StoryOnlySyntheticResponse): Promise<void>;
  summary(): Promise<Readonly<{ operations: Readonly<Record<string, number>>; total: number }>>;
  close(): Promise<void>;
}>;

export async function createStoryOnlySyntheticProvider(port = 0, host = "127.0.0.1"): Promise<StoryOnlySyntheticProvider> {
  const queued: StoryOnlySyntheticResponse[] = [];
  const operations = new Map<string, number>();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__summary") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ operations: Object.fromEntries(operations), total: [...operations.values()].reduce((sum, value) => sum + value, 0) }));
      return;
    }
    if (request.method === "POST" && request.url === "/__scenario") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.once("end", () => {
        try {
          const value = JSON.parse(body) as StoryOnlySyntheticResponse;
          if (typeof value.content !== "string" || value.content.length > 32_768 || (value.finishReason !== undefined && value.finishReason !== "stop" && value.finishReason !== "length") || (value.statusCode !== undefined && (!Number.isInteger(value.statusCode) || value.statusCode < 400 || value.statusCode > 599))) throw new Error("invalid");
          queued.push(value);
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ accepted: true }));
        } catch { response.writeHead(400).end(); }
      });
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    const operation = request.method === "POST" && request.url?.endsWith("/chat/completions")
      ? "chat.completions"
      : "other";
    operations.set(operation, (operations.get(operation) ?? 0) + 1);
    const complete = (next: StoryOnlySyntheticResponse) => {
      const statusCode = next.statusCode ?? 200;
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(statusCode >= 400
        ? { error: { message: "synthetic provider failure" } }
        : {
            id: `story-only-${randomUUID()}`,
            model: "story-only-test",
            choices: [{ message: { content: next.content }, finish_reason: next.finishReason ?? "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }));
    };
    if (operation !== "chat.completions") {
      request.resume();
      request.once("end", () => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unsupported synthetic operation" } }));
      });
      return;
    }
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      if (body.length + chunk.length > MAX_COMPLETION_REQUEST_CHARACTERS) {
        body = "";
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.once("end", () => {
      const next = queued.shift();
      const fallback = !tooLarge ? coverageFallback(body) : null;
      body = "";
      complete(next ?? { content: fallback ?? storyOnlyNarrativeResponse() });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic provider did not bind a local TCP port.");
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    async enqueue(response) { queued.push(response); },
    async summary() {
      return Object.freeze({ operations: Object.freeze(Object.fromEntries(operations)), total: [...operations.values()].reduce((sum, value) => sum + value, 0) });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  });
}
