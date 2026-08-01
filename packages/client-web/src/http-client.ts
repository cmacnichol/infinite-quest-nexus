import { ApiContractError, NexusApiError } from "@infinite-quest/client-core";
import type { HttpMethod, SessionPort } from "@infinite-quest/client-core";
import { apiErrorEnvelopeSchema } from "../../contracts/src/index.js";
import type { z } from "zod";

export type { HttpMethod } from "@infinite-quest/client-core";

export type RequestBody =
  | { kind: "json"; value: unknown }
  | { kind: "form-data"; value: FormData };

export interface BaseRequestSpec {
  method: HttpMethod;
  path: string;
  body?: RequestBody;
  accept?: string;
  signal?: AbortSignal;
}

export interface JsonRequestSpec<TResponse> extends BaseRequestSpec {
  responseKind?: "json";
  responseSchema: z.ZodType<TResponse>;
}

export interface EmptyRequestSpec extends BaseRequestSpec {
  responseKind: "empty";
  responseSchema?: never;
}

export interface BlobRequestSpec extends BaseRequestSpec {
  responseKind: "blob";
  responseSchema?: never;
}

export type RequestSpec<TResponse = unknown> =
  | JsonRequestSpec<TResponse>
  | EmptyRequestSpec
  | BlobRequestSpec;

export interface NexusHttpClient {
  request<TResponse>(spec: JsonRequestSpec<TResponse>): Promise<TResponse>;
  request(spec: EmptyRequestSpec): Promise<void>;
  request(spec: BlobRequestSpec): Promise<Blob>;
}

export interface NexusHttpClientOptions {
  basePath: string;
  session: SessionPort;
  fetchImpl?: typeof fetch;
}

function normalizeBasePath(basePath: string): string {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(basePath) ||
    basePath.startsWith("//") ||
    !basePath.startsWith("/") ||
    /[\\\u0000-\u001F\u007F]/.test(basePath)
  ) {
    throw new TypeError("Base path must be API-relative and begin with '/'.");
  }
  return basePath.replace(/\/+$/, "");
}

function apiPath(basePath: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new TypeError("Request path must be API-relative.");
  }
  if (!path.startsWith("/")) {
    throw new TypeError("Request path must begin with '/'.");
  }
  return `${basePath}${path}`;
}

function nonEmptyHeader(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function transportHeaders(spec: RequestSpec, authorization: Record<string, string>): Headers {
  const headers = new Headers(authorization);
  headers.delete("accept");
  headers.delete("content-type");

  const responseKind = spec.responseKind ?? "json";
  const accept = spec.accept ?? (responseKind === "json" ? "application/json" : undefined);
  if (accept) headers.set("accept", accept);
  if (spec.body?.kind === "json") headers.set("content-type", "application/json");
  return headers;
}

function requestBody(spec: RequestSpec): BodyInit | undefined {
  if (spec.body?.kind === "json") return JSON.stringify(spec.body.value);
  if (spec.body?.kind === "form-data") return spec.body.value;
  return undefined;
}

async function parseHttpError(response: Response): Promise<NexusApiError> {
  const retryAfter = nonEmptyHeader(response.headers.get("retry-after"));
  const headerCorrelationId = nonEmptyHeader(response.headers.get("x-correlation-id"));
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new NexusApiError(`Request failed with HTTP ${response.status}.`, {
      statusCode: response.status,
      correlationId: headerCorrelationId,
      retryAfter
    });
  }

  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new NexusApiError(`Request failed with HTTP ${response.status}.`, {
      statusCode: response.status,
      correlationId: headerCorrelationId,
      retryAfter
    });
  }

  const envelope = parsed.data;
  return new NexusApiError(envelope.message, {
    statusCode: response.status,
    correlationId: envelope.correlationId,
    errorName: envelope.error,
    domainCode: envelope.details.code ?? envelope.code ?? null,
    details: envelope.details,
    issues: envelope.issues,
    retryAfter
  });
}

async function parseSuccessfulResponse<TResponse>(
  spec: RequestSpec<TResponse>,
  response: Response
): Promise<TResponse | void | Blob> {
  const responseKind = spec.responseKind ?? "json";
  const correlationId = nonEmptyHeader(response.headers.get("x-correlation-id"));
  if (responseKind === "empty") return undefined;

  if (response.status === 204 || response.status === 205) {
    throw new ApiContractError("The API returned an unexpected empty response.", {
      phase: "response",
      kind: "unexpected_empty_response",
      method: spec.method,
      path: spec.path,
      statusCode: response.status,
      correlationId
    });
  }

  if (responseKind === "blob") return response.blob();

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ApiContractError("The API returned malformed JSON.", {
      phase: "response",
      kind: "malformed_json",
      method: spec.method,
      path: spec.path,
      statusCode: response.status,
      correlationId,
      cause
    });
  }

  if (!("responseSchema" in spec)) {
    throw new TypeError("A JSON response request requires a response schema.");
  }
  const parsed = spec.responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiContractError("The API response does not match its contract.", {
      phase: "response",
      kind: "response_schema_mismatch",
      method: spec.method,
      path: spec.path,
      statusCode: response.status,
      correlationId,
      issues: parsed.error.issues
    });
  }
  return parsed.data;
}

export function createNexusHttpClient(options: NexusHttpClientOptions): NexusHttpClient {
  const basePath = normalizeBasePath(options.basePath);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request<TResponse>(spec: RequestSpec<TResponse>): Promise<TResponse | void | Blob> {
    const path = apiPath(basePath, spec.path);
    let refreshedAuthorization = false;

    while (true) {
      spec.signal?.throwIfAborted();
      const authorization = await options.session.authorization();
      spec.signal?.throwIfAborted();
      const init: RequestInit = {
        method: spec.method,
        headers: transportHeaders(spec, authorization),
        cache: "no-store"
      };
      const body = requestBody(spec);
      if (body !== undefined) init.body = body;
      if (spec.signal) init.signal = spec.signal;
      const response = await fetchImpl(path, init);

      if ((response.status === 401 || response.status === 403) && !refreshedAuthorization) {
        const shouldRetry = await options.session.onUnauthorized({ statusCode: response.status });
        if (shouldRetry) {
          spec.signal?.throwIfAborted();
          refreshedAuthorization = true;
          continue;
        }
      }

      if (!response.ok) throw await parseHttpError(response);
      return parseSuccessfulResponse(spec, response);
    }
  }

  return { request } as NexusHttpClient;
}
