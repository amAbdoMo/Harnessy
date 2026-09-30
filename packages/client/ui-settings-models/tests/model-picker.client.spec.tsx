// @vitest-environment jsdom
/**
 * The fetched-model picker: the order it offers a listing in, and the action
 * that adopts picks from it.
 *
 * A provider reports its models in its own order, which leaves one that just
 * appeared in its catalog below every row this profile already configures.
 * These cases read the rendered dialog rather than the ordering helper, so they
 * assert what the picker shows.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** The Host operations the editor reaches, scripted down to the one it asks. */
function operations(discoverModels: ModelsOperations['discoverModels']): ModelsOperations {
  return {
    discoverModels,
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
  }
}

/**
 * Render the editor over one scripted listing and open the picker.
 * @param listing - the models the interrogation answers with, in its order.
 * @param configured - the models the profile already holds.
 * @returns the open dialog.
 */
async function openPicker(
  listing: readonly LlmDiscoveredModel[],
  configured: readonly ModelDraft[],
): Promise<{ dialog: HTMLElement }> {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[...configured]}
    onChange={onChange}
    operations={operations(() => Promise.resolve({ kind: 'found', models: listing }))}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }}
    disabled={false}
    t={key => en[key]}
    onBusyChange={() => {}}
    efforts={[]}
    catalogServed={false}
  />)
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  return { dialog: await screen.findByRole('dialog', { name: en.fetchTitle }) }
}

/** The visible model ids the picker offers, in document order. */
function offeredIds(dialog: HTMLElement): string[] {
  return within(dialog).getAllByRole('checkbox').map(box =>
    box.parentElement?.querySelector('span')?.textContent ?? '')
}

/** The picker's add action. */
function addAction(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole<HTMLButtonElement>('button', { name: en.fetchAdopt })
}

it('offers the models this profile does not configure before the ones it holds', async () => {
  const { dialog } = await openPicker(
    [{ id: 'held-first' }, { id: 'new-first' }, { id: 'held-second' }, { id: 'new-second' }],
    [{ id: 'held-first' }, { id: 'held-second' }],
  )

  expect(offeredIds(dialog)).toEqual(['new-first', 'new-second', 'held-first', 'held-second'])
  expect(addAction(dialog).disabled).toBe(false)
})

it('keeps the source order inside each group, so two listings read the same', async () => {
  const listing = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const unconfiguredFirst = await openPicker(listing, [{ id: 'b' }])
  expect(offeredIds(unconfiguredFirst.dialog)).toEqual(['a', 'c', 'b'])
  cleanup()

  const allConfigured = await openPicker(listing, [{ id: 'b' }, { id: 'a' }, { id: 'c' }])
  expect(offeredIds(allConfigured.dialog)).toEqual(['a', 'b', 'c'])
})

it('disables the add action while the picker holds no selection', async () => {
  const { dialog } = await openPicker([{ id: 'held' }], [{ id: 'held' }])
  expect(addAction(dialog).disabled).toBe(true)
})

it('enables the add action once a candidate is picked, and disables it again when it is dropped', async () => {
  const { dialog } = await openPicker([{ id: 'held' }], [{ id: 'held' }])
  const add = addAction(dialog)

  fireEvent.click(within(dialog).getByRole('checkbox', { name: /^held/ }))
  expect(add.disabled).toBe(false)

  fireEvent.click(within(dialog).getByRole('checkbox', { name: /^held/ }))
  expect(add.disabled).toBe(true)
})
