import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { test as webTest } from '@e2e-dev/web';
import { expect } from 'e2e';
import { appLog } from './runtime.ts';

/** Authenticate only against this run's isolated Host, never the live GUI's cookies. */
export const test = webTest.extend<{ authenticatedHarness: void }>({
  authenticatedHarness: async ({ app }, use) => {
    if (process.env.APP_URL !== undefined) {
      await app.open();
    } else {
      const origin = new URL(app.baseUrl!).origin;
      let launchUrl: URL | undefined;
      await expect.poll(async () => {
        const log = stripVTControlCharacters(await readFile(appLog, 'utf8'));
        for (const match of log.matchAll(/^dsh web: (http:\/\/\S+)/gm)) {
          const candidate = new URL(match[1]!);
          if (candidate.origin === origin) launchUrl = candidate;
        }
        return launchUrl;
      }, { timeout: 15_000, message: 'the owned Harness process announces its authenticated URL' }).toBeDefined();
      await app.open(launchUrl!.href);
    }
    await use(undefined);
  },
});
