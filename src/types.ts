export interface FileEntry { content: Buffer; mode: number }
export type Snapshot = Map<string, FileEntry>;

export interface Oracle { exitCode: number; allOf: string[]; noneOf: string[] }
export interface Config {
  version: 1;
  name: string;
  command: string[];
  oracle: Oracle;
  adapter: 'auto' | 'next' | 'generic';
  budget: { maxEvaluations: number; maxSeconds: number };
  runs: { baseline: number; candidate: number; final: number };
  execution: { timeoutMs: number; maxOutputBytes: number; installTimeoutMs: number; allowInstallScripts: boolean; env: string[] };
  reduce: { files: boolean; syntax: boolean; json: boolean; dependencies: boolean };
  include: string[];
  exclude: string[];
  preserve: string[];
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}
export type Outcome = 'reproduced' | 'absent' | 'invalid';
export interface OracleResult {
  status: Outcome;
  reason: string;
  matched: string[];
  missing: string[];
  forbidden: string[];
  diagnostics: string[];
}
export interface Observation { execution: CommandResult; oracle: OracleResult }

export interface FileEdit { path: string; content: Buffer | null }
export type TransformKind = 'files' | 'syntax' | 'json' | 'dependencies';
export interface Transformation {
  id: string;
  kind: TransformKind;
  description: string;
  paths: string[];
  edits: FileEdit[];
}
export interface ProjectGraph {
  imports: Record<string, string[]>;
  external: Record<string, string[]>;
  unresolved: Record<string, string[]>;
}
export interface AdapterInfo {
  name: 'next' | 'generic';
  version: string | null;
  router: 'app' | 'pages' | 'mixed' | 'none';
  entrypoints: string[];
  protectedPaths: string[];
  warnings: string[];
}
export interface Metrics { files: number; bytes: number; sourceBytes: number; dependencies: number }
export interface ReviewFinding { path: string; kind: string; message: string }
export interface Inventory { snapshot: Snapshot; excluded: { path: string; reason: string }[]; warnings: string[] }
export interface Trial {
  index: number;
  candidateHash: string;
  kind: TransformKind;
  description: string;
  paths: string[];
  status: Outcome;
  accepted: boolean;
  reason: string;
  durationMs: number;
  before: Metrics;
  after: Metrics;
  confirmations: number;
  diagnostics: string[];
}
export interface RuntimeInfo { node: string; npm: string; platform: string; arch: string; tool: string }
export interface Verification {
  status: 'pending' | 'verified' | 'failed';
  runs: number;
  reason: string;
  snapshotHash: string;
  environment: 'fresh-directory';
}
export interface RunState {
  version: 1;
  id: string;
  sourceRoot: string;
  createdAt: string;
  updatedAt: string;
  config: Config;
  configHash: string;
  runtime: RuntimeInfo;
  originalHash: string;
  bestHash: string;
  initial: Metrics;
  current: Metrics;
  adapter: AdapterInfo;
  status: 'calibrating' | 'reducing' | 'paused' | 'verifying' | 'complete' | 'failed';
  stopReason: string;
  evaluations: number;
  elapsedMs: number;
  baseline: OracleResult[];
  trials: Trial[];
  rejectedHashes: string[];
  excluded: { path: string; reason: string }[];
  warnings: string[];
  verification: Verification;
  reviewFindings: ReviewFinding[];
}
export interface RunReport {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  status: RunState['status'];
  stopReason: string;
  command: string[];
  oracle: Oracle;
  runtime: RuntimeInfo;
  adapter: AdapterInfo;
  initial: Metrics;
  current: Metrics;
  evaluations: number;
  elapsedMs: number;
  baseline: { completed: number; required: number };
  trials: Trial[];
  files: { path: string; bytes: number }[];
  excluded: { path: string; reason: string }[];
  warnings: string[];
  verification: Verification;
  reviewFindings: ReviewFinding[];
}
