import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Workers reload the config; inheriting the id keeps their config digest identical.
const runId = process.env.HARNESS_E2E_RUN_ID ??= randomUUID();
export const harnessHome = resolve('.e2e/home', runId);
export const workspaceRoot = resolve(harnessHome, 'workspace');
export const appLog = resolve('.e2e/logs', `${runId}.log`);
mkdirSync(workspaceRoot, { recursive: true });
