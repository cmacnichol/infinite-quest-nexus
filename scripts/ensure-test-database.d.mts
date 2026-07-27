export interface TestDatabaseConfig {
  databaseName: string;
  databaseUrl: string;
  adminDatabaseUrl: string;
  environmentFile: string;
}

export interface TestDatabaseClient {
  connect(): Promise<void>;
  query(query: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface EnsureTestDatabaseOptions {
  projectRoot?: string;
  execute?: (command: string, argumentsList: string[], options: { cwd: string }) => Promise<void>;
  createClient?: (connectionString: string) => TestDatabaseClient;
  generatePassword?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function loadTestDatabaseConfig(
  projectRoot: string,
  options?: { generatePassword?: () => string }
): Promise<TestDatabaseConfig>;

export function ensureTestDatabase(options?: EnsureTestDatabaseOptions): Promise<TestDatabaseConfig>;
