import {
  preparedResponseContractSchema,
  type PreparedResponseContract,
  type ResponseFormatDiagnosticCode
} from "../../contracts/src/text-response-format.js";
import { getProviderOutputSchema } from "./provider-output-schema.js";
import { sha256, stableStringify } from "../../domain/src/text.js";

export { type PreparedResponseContract, type ResponseFormatDiagnosticCode };

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

export function prepareResponseContract(value: unknown): PreparedResponseContract {
  const contract = preparedResponseContractSchema.parse(value);
  if (contract.mode === "json_schema") {
    const source = getProviderOutputSchema(contract.operation);
    if (contract.schemaHash !== source.schemaHash || contract.schemaVersion !== source.version || contract.schemaName !== source.name) {
      throw new Error("Prepared response contract does not match the registered schema identity.");
    }
    if (sha256(stableStringify(contract.schema)) !== contract.schemaHash || stableStringify(contract.schema) !== stableStringify(source.schema)) {
      throw new Error("Prepared response contract schema body was tampered.");
    }
  }
  return freezeDeep({ ...contract, ...(contract.mode === "json_schema" ? { providerRoutingSlugs: [...contract.providerRoutingSlugs] } : {}) });
}

export function classifyResponseFormatFailure(status: number, value: unknown): ResponseFormatDiagnosticCode | null {
  const error = value && typeof value === "object" ? (value as { error?: unknown }).error ?? value : {};
  const code = typeof (error as any).code === "string" ? (error as any).code.toLowerCase() : "";
  const type = typeof (error as any).type === "string" ? (error as any).type.toLowerCase() : "";
  const param = typeof (error as any).param === "string" ? (error as any).param.toLowerCase() : "";
  const signal = `${code} ${type} ${param}`;
  if (/refusal|content_filter/.test(signal)) return "provider_refusal";
  if (/route|provider.*unavailable|no_endpoint/.test(signal) || (status === 404 && /provider|route/.test(signal))) return "provider_route_unavailable";
  if (/schema|response_format|structured/.test(signal)) return /invalid|malformed/.test(signal) ? "provider_schema_invalid" : "provider_schema_unsupported";
  return null;
}
