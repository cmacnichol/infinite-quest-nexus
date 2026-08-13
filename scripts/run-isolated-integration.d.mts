export function discoverIntegrationTestFiles(root?: string): Promise<string[]>;

export function integrationTestArguments(testFile: string): string[];

export function runIsolatedIntegrationSuite(): Promise<void>;
