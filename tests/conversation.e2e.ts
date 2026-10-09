import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, unique } from 'e2e';
import { test } from './support/harness.ts';
import { workspaceRoot } from './support/runtime.ts';

const chatTest = test.extend<{ workspace: string }>({
  workspace: async (_, use) => {
    const workspace = await mkdtemp(join(workspaceRoot, 'chat-'));
    try {
      await use(workspace);
    } finally {
      await rm(workspace, { recursive: true });
    }
  },
});

chatTest('a new workspace session retains its conversation after reload', { timeout: 300_000 }, async ({ agent, screen, browser, workspace }) => {
  if (process.env.APP_URL !== undefined) {
    throw new Error('This conversation test requires the isolated replay server; unset APP_URL.');
  }
  const composer = screen.getByRole('textbox', /^(Describe what you want to build|Message or run a task), \/ commands, @ files or sessions$/);
  const workspaceRow = screen.getByRole('treeitem', basename(workspace));
  const currentWorkspace = screen.getByRole('button', 'Choose workspace');
  await expect(workspaceRow).not.toBeVisible();
  await agent.act('Open a new session in the workspace at {directory} using Choose workspace.', {
    params: { directory: unique(workspace) },
  });
  await expect(workspaceRow).toBeVisible();
  await expect(currentWorkspace).toHaveText(basename(workspace));
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveText('');

  const prompt = '只回复 MESSAGES_WEB_READY，不调用工具。';
  await composer.fill(prompt);
  await expect(composer).toHaveText(prompt);
  await agent.act('Send the message already entered in the composer.');
  await expect(screen.getByText('MESSAGES_WEB_READY')).toBeVisible();
  await expect(screen.getByRole('status')).toHaveText('Completed');
  await expect(screen.getByText(prompt)).toBeVisible();
  await expect(composer).toHaveText('');
  await expect(screen.getByRole('button', 'Send message')).toBeDisabled();

  await browser.reload();
  await expect(workspaceRow).toBeVisible();
  await expect(screen.getByText(prompt)).toBeVisible();
  await expect(screen.getByText('MESSAGES_WEB_READY')).toBeVisible();
});
