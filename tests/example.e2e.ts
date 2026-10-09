import { expect } from 'e2e';
import { test } from './support/harness.ts';

test('Harness opens with its message composer', async ({ browser }) => {
  await expect(browser.locator('[data-composer-input][role="textbox"]').first()).toBeVisible();
});
