export interface LegacyUiFixtureOptions {
  readonly turnCount?: number;
  readonly worldCount?: number;
  readonly campaignCount?: number;
}

export interface LegacyUiFixture {
  readonly turnCount: number;
  readonly worlds: Record<string, unknown>[];
  readonly worldDetails: Map<string, Record<string, unknown>>;
  readonly campaigns: Record<string, unknown>[];
  readonly campaignId: string;
  readonly worldId: string;
  readonly worldVersionId: string;
  readonly turns: Record<string, unknown>[];
  readonly syncStatus: Record<string, unknown>;
  readonly runtimeState: Record<string, unknown>;
  readonly session: Record<string, unknown>;
  readonly dashboardStats: Record<string, unknown>;
}

export interface LegacyUiRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly requestBytes: number;
  responseBytes: number;
  readonly startedAt: number;
  readonly configuredDelayMs: number;
  readonly delayReleaseTimeoutMs: number;
  delayReleasedAt?: number;
  delayReleaseKind?: "explicit" | "timeout";
  finishedAt?: number;
  status?: number;
}

export interface LegacyUiRouteOptions {
  readonly delays?: Readonly<Record<string, number>>;
  readonly failures?: Readonly<Record<string, number>>;
  /** Overrides automatic release only when explicitly set for a controlled delayed route. */
  readonly manualDelayReleaseTimeoutMs?: number;
}

export interface LegacyUiRouteInstrumentation {
  readonly requests: LegacyUiRequestRecord[];
  readonly writes: Array<{ method: string; path: string; body: unknown }>;
  readonly releaseDelayedRoute: () => void;
}
