import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DesktopNotificationActivation,
  notificationActivationUri,
  parseNotificationActivationArguments,
  parseNotificationActivationUri,
  windowsNotificationToastXml,
} from '../src/notification-activation.ts'

// OS input cases include empty/maximum/oversized IDs, malformed escapes, URI extras, and Unicode controls.
describe('product notification activation URI', () => {
  it('opens the app without Session metadata for a generic notification', () => {
    const uri = notificationActivationUri({})
    expect(uri).toBe('harnessy://open')
    expect(parseNotificationActivationUri(uri)).toEqual({})
  })

  it.each(['session-1', '../opaque/ID?#&"', 'جلسة-😀', 'a'.repeat(200)])('round-trips an opaque Session id %s', (opaqueId) => {
    const sessionId = SessionId(opaqueId)
    expect(parseNotificationActivationUri(notificationActivationUri({ sessionId }))).toEqual({ sessionId })
  })

  it.each([
    '', 'dsh://open', 'https://session/id', 'HARNESSY://open', 'harnessy://open/',
    'harnessy://open?session=id', 'harnessy://session', 'harnessy://session/',
    'harnessy://session/id/extra', 'harnessy://session/id?workspace=other', 'harnessy://session/id#action',
    'harnessy://user@session/id', 'harnessy://session:123/id', 'harnessy://session\\id',
    'harnessy://session/%', 'harnessy://session/%C0%AF', 'harnessy://session/%ED%A0%80',
    'harnessy://session/%61', 'harnessy://session/%2f', 'harnessy://session/raw space',
    ...[' ', '\t', '\n', '\u0000', '\u007f', '\u0085', '\u00a0', 'a'.repeat(201)].map(id => `harnessy://session/${encodeURIComponent(id)}`),
    `harnessy://session/${'%41'.repeat(801)}`,
  ])('ignores an unrelated or malformed OS URI %j', (uri) => {
    expect(parseNotificationActivationUri(uri)).toBeUndefined()
  })

  it('reads the latest valid URI without treating launch flags as commands', () => {
    expect(parseNotificationActivationArguments([
      'Harnessy.exe', '--profile=private', 'harnessy://session/first',
      '--uri=harnessy://session/injected', 'harnessy://session/latest', 'harnessy://session/bad?command=approve',
    ])).toEqual({ sessionId: SessionId('latest') })
    expect(parseNotificationActivationArguments(['Harnessy.exe', '--updated'])).toBeUndefined()
    expect(parseNotificationActivationArguments(['harnessy://session/first', 'harnessy://open'])).toEqual({})
  })
})

describe('Windows protocol toast XML', () => {
  it('escapes copy and uses the bundled disk logo with Session metadata only in launch', async () => {
    const iconPath = resolve('Harnessy & product', 'icon.png')
    const xml = windowsNotificationToastXml({
      title: 'Title <&> "quoted"', body: "Body 'text' & <tag>", sessionId: SessionId('private/session?ID'),
    }, iconPath)
    const logoUri = pathToFileURL(iconPath).href.replaceAll('&', '&amp;')
    expect(xml).toContain(`<image placement="appLogoOverride" src="${logoUri}"/>`)
    // Only the fixture's machine-specific disk location is replaced in this Windows presentation expectation.
    await expect(xml.replace(logoUri, '{{bundled-logo}}') + '\n').toMatchFileSnapshot('./expected/native-task-toast.xml')
    expect(xml).not.toContain('<text>private')
  })

  it('bounds XML copy without splitting astral text or preserving invalid XML characters', () => {
    const xml = windowsNotificationToastXml({ title: `${'a'.repeat(119)}😀extra`, body: `${'b'.repeat(497)}\u0000😀extra` }, resolve('icon.png'))
    expect(xml).toContain('launch="harnessy://open" activationType="protocol"')
    expect(xml).toContain(`<text>${'a'.repeat(119)}</text>`)
    expect(xml).toContain(`<text>${'b'.repeat(497)}\ufffd😀</text>`)
    expect(xml).not.toContain('extra')
    expect(xml).not.toContain('\u0000')
  })
})

describe('queued notification activation', () => {
  it('retains only the latest Session until the owned workspace can receive it', () => {
    const activation = new DesktopNotificationActivation()
    const selections: SessionId[] = []
    let focused = 0
    let ready = false
    activation.activate({ sessionId: SessionId('startup') })
    activation.activate({ sessionId: SessionId('latest') })
    activation.connect({
      focus: () => { focused++ },
      selectSession: (id) => { if (!ready) return false; selections.push(id); return true },
    })
    expect(focused).toBe(1)
    expect(selections).toEqual([])
    activation.flush()
    ready = true
    activation.flush()
    activation.flush()
    expect(focused).toBe(1)
    expect(selections).toEqual([SessionId('latest')])
  })

  it('focuses generic opens without replacing a pending Session, and permits later repeated selections', () => {
    const activation = new DesktopNotificationActivation()
    let ready = false
    let focused = 0
    const selections: SessionId[] = []
    activation.connect({
      focus: () => { focused++ },
      selectSession: (id) => { if (!ready) return false; selections.push(id); return true },
    })
    activation.activate({ sessionId: SessionId('pending') })
    activation.activate({})
    ready = true
    activation.flush()
    activation.activate({ sessionId: SessionId('pending') })
    activation.activate({})
    expect(focused).toBe(4)
    expect(selections).toEqual([SessionId('pending'), SessionId('pending')])
  })
})
