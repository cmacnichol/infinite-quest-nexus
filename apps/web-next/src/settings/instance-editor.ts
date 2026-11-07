import type { SettingsFieldDescriptor } from "@infinite-quest/contracts";
/** Decimal arithmetic via bigint prevents rounding a policy boundary into an allowed value. */
export function fromDisplayUnit(text: string, factor: number): number {
  if (!/^\d+(?:\.\d{1,60})?$/.test(text) || text.length > 80) throw new Error("Enter an exact positive number.");
  const [whole, fraction = ""] = text.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole! + fraction) * BigInt(factor);
  if (numerator % denominator !== 0n) throw new Error("This value must convert to a whole base unit.");
  const value = numerator / denominator;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This value is too large.");
  return Number(value);
}
export function toDisplayUnit(value: number, factor: number): string {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(factor) || factor < 1) throw new Error("Invalid unit value.");
  const divisor = BigInt(factor); const integer = BigInt(value); let remainder = integer % divisor;
  let fraction = "";
  while (remainder && fraction.length < 60) { remainder *= 10n; fraction += String(remainder / divisor); remainder %= divisor; }
  return String(integer / divisor) + (fraction ? `.${fraction}` : "");
}
export function displayUnit(field: SettingsFieldDescriptor): { factor: number; label: string } {
  if (field.unit === "bytes") return { factor: field.key.endsWith("maxUncompressedBytes") ? 1073741824 : 1048576, label: field.key.endsWith("maxUncompressedBytes") ? "GiB" : "MiB" };
  if (field.unit === "milliseconds") return { factor: 1000, label: "seconds" };
  if (field.unit === "seconds") return { factor: field.key.includes("Ttl") ? 60 : 1, label: field.key.includes("Ttl") ? "minutes" : "seconds" };
  return { factor: 1, label: field.unit === "ratio" ? "× expansion" : field.unit === "count" ? (field.key.endsWith("maxEntries") ? "files" : field.key === "workerGenerationConcurrency" ? "jobs per worker" : field.key === "textProviderConcurrency" ? "shared slots" : "requests") : "" };
}
export function readableValue(field: SettingsFieldDescriptor, value: boolean | string | number): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value;
  const unit = displayUnit(field); return `${toDisplayUnit(value, unit.factor)} ${unit.label}`.trim();
}

/** Range copy chooses exact, familiar units without exposing tiny binary fractions. */
export function readableRangeValue(field: SettingsFieldDescriptor, value: number): string {
  if (field.unit !== "bytes") return readableValue(field, value);
  for (const [factor, label] of [[1073741824, "GiB"], [1048576, "MiB"], [1024, "KiB"]] as const) {
    if (value >= factor && value % factor === 0) return `${value / factor} ${label}`;
  }
  return `${value.toLocaleString("en-US")} ${value === 1 ? "byte" : "bytes"}`;
}
