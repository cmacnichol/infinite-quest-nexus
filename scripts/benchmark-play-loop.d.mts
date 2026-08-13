export interface PlayLoopBenchmarkOptions {
  databaseUrl?: string;
  samples?: number;
  warmups?: number;
}

export interface PlayLoopRouteMetric {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  latencyVarianceRatio: number;
  payloadBytesP50: number;
  payloadBytesP95: number;
  queryCount: number;
  queryCounts: number[];
  errorRate: number;
}

export interface PlayLoopQueryPlan {
  name: string;
  planningTimeMs: number;
  executionTimeMs: number;
  actualRows: number;
  nodeTypes: string[];
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  sharedWrittenBlocks: number;
  temporaryReadBlocks: number;
  temporaryWrittenBlocks: number;
}

export interface PlayLoopBenchmarkResult {
  benchmark: "play-loop-reads-v1";
  generatedAt: string;
  profile: {
    target: { cpu: string; memory: string };
    targetSatisfied: boolean;
    actual: {
      hostname: string;
      availableCpuCount: number;
      cgroupMemoryLimitGiB: number | null;
      hostTotalMemoryGiB: number;
      platform: NodeJS.Platform;
      architecture: string;
      node: string;
    };
  };
  warmups: number;
  samples: number;
  postgresVersion: string;
  routes: Record<string, PlayLoopRouteMetric>;
  plans: PlayLoopQueryPlan[];
  fixture: {
    seed: string;
    campaigns: Record<string, {
      turns: number;
      generationJobs: number;
      imageJobs: number;
      chronicleMemories: number;
    }>;
  };
  boundedReadEvidence: {
    requestedLimit: number;
    firstPageTurns: number;
    middlePageTurns: number;
    lastPageTurns: number;
    firstPageHasCursor: boolean;
    lastPageHasCursor: boolean;
    syncInitialTurns: number;
    syncInitialMode: string;
  };
}

export function runPlayLoopBenchmark(options?: PlayLoopBenchmarkOptions): Promise<PlayLoopBenchmarkResult>;
