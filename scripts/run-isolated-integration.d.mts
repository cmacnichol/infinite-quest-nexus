export function discoverIntegrationTestFiles(root?: string): Promise<string[]>;

export function integrationTestCommand(testFile: string): {
  executable: string;
  arguments: string[];
};

export function runIsolatedIntegrationSuite(): Promise<void>;
