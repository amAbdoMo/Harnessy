import { expect, it } from 'vitest'
import { resolveDragFileName } from '../src/index.ts'

it.each([
  [{ name: 'photo.jpeg', mediaType: 'image/jpeg' }, 'photo.jpeg'],
  [{ name: 'photo.JPEG', mediaType: 'IMAGE/JPEG; charset=utf-8' }, 'photo.JPEG'],
  [{ name: '报告', mediaType: 'application/pdf' }, '报告.pdf'],
  [{ mediaType: 'application/pdf' }, 'file.pdf'],
  [{ name: 'report.png', mediaType: 'application/pdf' }, 'report.pdf'],
  [{ name: 'report.pdf', mediaType: 'application/pdf', outputExtension: '.bin' }, 'report.bin'],
  [{ name: 'report', mediaType: 'application/pdf', outputExtension: 'bin' }, 'report.bin'],
  [{ name: 'custom.asset', mediaType: 'application/x-custom' }, 'custom.asset'],
  [{ name: 'custom', mediaType: 'application/x-custom' }, 'custom'],
  [{ name: '  .. ', mediaType: '' }, 'file'],
  [{ name: 'CON.pdf', mediaType: 'application/pdf' }, '_CON.pdf'],
  [{ name: '../../report.pdf', mediaType: 'application/pdf' }, '_.._report.pdf'],
])('resolves %j to %s', (request, expected) => {
  expect(resolveDragFileName(request)).toBe(expected)
})

it('bounds the filename without cutting off its extension', () => {
  expect(resolveDragFileName({ name: `${'a'.repeat(500)}.pdf`, mediaType: 'application/pdf' })).toBe(`${'a'.repeat(120)}.pdf`)
})
