import { resolve } from 'node:path';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { appLog, harnessHome, workspaceRoot } from './tests/support/runtime.ts';

export default {
  workers: 1,
  retries: 0,
  agents: {
    default: {
      model: chatgpt('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
      context: 'Harness is an agent chat app. The test instance has a tool-free replay model.',
    },
  },
  targets: [{
    name: 'harness-web',
    engine: web({ locale: 'en-US', viewport: { width: 1680, height: 1000 } }),
    app: process.env.APP_URL === undefined ? {
      url: 'http://127.0.0.1:0',
      command: {
        executable: process.execPath,
        args: [
          resolve('apps/cli/lib/bin.js'), 'web',
          '--patch', resolve('tests/support/replay.overlay.yml'),
          '--host', '127.0.0.1', '--port', '{port}', '--no-open',
        ],
        cwd: workspaceRoot,
        env: {
          DSH_HOME: harnessHome,
          HOME: harnessHome,
          USERPROFILE: harnessHome,
          DSH_AGENTS_HOME: resolve(harnessHome, 'agents'),
          DSH_BUNDLED_SKILL_DIR: resolve(harnessHome, 'skills'),
          DSH_SNAPSHOT_FILE: resolve('snapshots/web/deepseek-messages-chat/session.v3.jsonl'),
        },
        startupTimeout: 120_000,
        log: appLog,
      },
    } : { url: process.env.APP_URL },
  }],
} satisfies E2EConfig;
