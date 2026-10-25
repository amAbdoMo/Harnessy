import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import { isSea } from 'node:sea'
import { describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { strToU8, zipSync } from 'fflate'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']

describe('bundled Office skills', () => {
  it('loads each packaged body and removes all candidates on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillOffice)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      for (const skill of catalog) {
        expect(skill.description.length).toBeLessThanOrEqual(500)
        expect(skill).toMatchObject({ source: 'bundled', provider: 'dsh-office', invocation: { modelInvocable: true, userInvocable: true } })
        const loaded = await ctx.skills.get(skill.name)
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name) })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        expect(loaded?.content).toContain(raw.slice(raw.indexOf('\n---\n') + 5).trim())
        if (['office-render', 'office-recalculate', 'office-export-pdf'].includes(skill.name)) {
          expect(loaded?.content).toContain(JSON.stringify(process.execPath))
          expect(loaded?.content).toContain('libreofficeKit')
        } else {
          expect(loaded?.content).not.toContain('libreofficeKit')
        }
      }
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('loads relocated resources through a real cordis.yml composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-skills-'))
    const ctx = new Context()
    try {
      const external = join(root, '中文 assets')
      await cp(assets, external, { recursive: true })
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-skill'",
        "- name: '@deepseek-ai/dsh-skill-office'",
        '  config:',
        `    assetRoot: ${JSON.stringify(external)}`,
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-skill', SkillRegistry],
        ['@deepseek-ai/dsh-skill-office', SkillOffice],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
      const loaded = await ctx.skills.get('office-xlsx')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'office-xlsx') })
      const raw = await readFile(join(external, 'office-xlsx', 'SKILL.md'), 'utf8')
      expect(loaded?.content).toContain(raw.slice(raw.indexOf('\n---\n') + 5).trim())
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['description: "Quoted: description"', '\r\n', 'Quoted: description'],
    ['description: >-\n  Folded\n  description', '\n', 'Folded description'],
  ])('parses frontmatter %s and leaves body metadata-like lines intact', async (header, newline, description) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-metadata-'))
    const ctx = new Context()
    try {
      await cp(assets, root, { recursive: true })
      const body = '# Office instructions\n\ndescription: instruction text'
      await writeFile(join(root, 'office-docx', 'SKILL.md'), `---\n${header}\n---\n\n${body}\n`.replaceAll('\n', newline))
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillOffice, { assetRoot: root, cli: false })
      const skill = await ctx.skills.get('office-docx')
      expect(skill?.description).toBe(description)
      expect(skill?.content).toBe(body.replaceAll('\n', newline))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative resource paths and incomplete asset trees before registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-invalid-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillOffice.apply(ctx, { assetRoot: 'assets' }) }).toThrow('absolute directory')
      await cp(assets, root, { recursive: true })
      await rm(join(root, 'office-render', 'SKILL.md'))
      expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow()
      await cp(join(assets, 'office-render', 'SKILL.md'), join(root, 'office-render', 'SKILL.md'))
      await writeFile(join(root, 'office-docx', 'SKILL.md'), '# Missing frontmatter\ndescription: body text\n')
      expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow('has no YAML frontmatter')
      for (const header of ['', 'null', 'scalar', 'name: office-docx', 'description: 3', 'description: ""']) {
        await writeFile(join(root, 'office-docx', 'SKILL.md'), `---\n${header}\n---\n# Instructions\n`)
        expect(() => { SkillOffice.apply(ctx, { assetRoot: root }) }).toThrow('has no description')
      }
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('rejects unavailable CLI and Node paths before exposing an executable command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-command-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    for (const config of [{ node: 'node' }, { cli: 'cli.js' }, { node: root }, { cli: root }, { cli: join(root, 'missing.js') }]) {
      expect(() => { SkillOffice.apply(ctx, config) }).toThrow()
      expect(await ctx.skills.list()).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('executes capabilities, PDF export and image export using only loaded paths from a separate workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office CLI 工作目录 '))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillOffice)
    const skill = await ctx.skills.get('office-render')
    const json = skill?.content.match(/\n(\{\n[\s\S]+)$/u)?.[1]
    expect(json).toBeDefined()
    const { libreofficeKit } = JSON.parse(json!) as { libreofficeKit: { node: string; cli: string } }
    const result = await execa(libreofficeKit.node, [libreofficeKit.cli, 'capabilities'], {
      cwd: root, env: { PATH: '' }, timeout: 20_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ runtime: { version: '0.1.5', cliPath: libreofficeKit.cli } })
    const input = join(root, 'input.docx')
    const original = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office CLI discovery</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'),
    })
    await writeFile(input, original)
    const pdf = join(root, 'result.pdf')
    await execa(libreofficeKit.node, [libreofficeKit.cli, 'convert', '--input', input, '--output', pdf], {
      cwd: root, env: { PATH: '' }, timeout: 30_000, killSignal: 'SIGKILL',
    })
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
    const preview = join(root, 'exported-images')
    await execa(libreofficeKit.node, [libreofficeKit.cli, 'render', '--input', input, '--output-dir', preview, '--pages', '1'], {
      cwd: root, env: { PATH: '' }, timeout: 30_000, killSignal: 'SIGKILL',
    })
    const images = (await readdir(preview)).filter(path => path.endsWith('.png'))
    expect(images).toHaveLength(1)
    expect((await readFile(join(preview, images[0]!))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(await readFile(input)).toEqual(Buffer.from(original))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('requires standalone Node in Electron and SEA, while permitting explicit CLI opt-out', async () => {
  const ctx = new Context()
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  try {
    await ctx.plugin(SkillRegistry)
    vi.mocked(isSea).mockReturnValue(true)
    expect(() => { SkillOffice.apply(ctx) }).toThrow('standalone Node')
    vi.mocked(isSea).mockReturnValue(false)
    Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
    expect(() => { SkillOffice.apply(ctx) }).toThrow('standalone Node')
    const fiber = await ctx.plugin(SkillOffice, { cli: false })
    expect((await ctx.skills.get('office-render'))?.content).toContain('disabled in this deployment')
    await fiber.dispose()
    await ctx.plugin(SkillOffice, { node: process.execPath })
    expect((await ctx.skills.get('office-render'))?.content).toContain(JSON.stringify(process.execPath))
  } finally {
    vi.mocked(isSea).mockReturnValue(false)
    if (original === undefined) Reflect.deleteProperty(process.versions, 'electron')
    else Object.defineProperty(process.versions, 'electron', original)
    await ctx.fiber.dispose()
  }
})
