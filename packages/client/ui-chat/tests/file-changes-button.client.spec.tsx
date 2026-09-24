// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { en } from '../src/client/locale.ts'
import { FileChangesButton } from '../src/client/chat/FileChangesButton.tsx'

afterEach(cleanup)

const t = makeTranslate(en) as ChatViewSlotProps['t']
const changes = {
  files: [{
    path: 'src/app.ts',
    diffs: [{ path: 'src/app.ts', oldText: 'old\n', newText: 'new\nnext\n' }],
    added: 2,
    removed: 1,
  }],
  added: 2,
  removed: 1,
} as const

describe('Turn file changes disclosure', () => {
  it('opens the recorded file in the diff viewer', () => {
    const openDiff = vi.fn()
    render(<FileChangesButton changes={changes} openDiff={openDiff} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /1 files changed/i }))
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }))

    expect(openDiff).toHaveBeenCalledWith('src/app.ts', changes.files[0].diffs)
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('closes the file list with Escape', () => {
    render(<FileChangesButton changes={changes} openDiff={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /1 files changed/i }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /1 files changed/i }))
  })
})
