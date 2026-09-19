export type PresetSummary = Readonly<{
  slug: string;
  name: string;
  status: string;
  designatedVersionId: string;
  updatedAt: string;
}>;

export type PresetPage = Readonly<{
  presets: readonly PresetSummary[];
  totalCount: number;
  offset: number;
  nextOffset: number | null;
}>;

export type ResolvedPreset = Readonly<{
  slug: string;
  name: string;
  versionId: string;
  version: number;
  systemPrompt: string;
  config: Readonly<Record<string, unknown>>;
  configHash: string;
}>;

export type ProviderPresetDiagnosticCode =
  | "authentication"
  | "discovery_unavailable"
  | "preset_missing"
  | "preset_inactive"
  | "preset_config_unsupported"
  | "invalid_response";
