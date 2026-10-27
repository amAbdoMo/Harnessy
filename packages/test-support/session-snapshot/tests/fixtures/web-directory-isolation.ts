/** Hide the Windows ACL diagnosis skill from Web fixture transcripts. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'web-directory-fixture-isolation'
export const inject = ['skills']

/** @param ctx - assembled Web test composition. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Windows ACL diagnosis is outside this recorded Web fixture.',
    content: '',
    source: 'custom',
    invocation: { modelInvocable: false, userInvocable: false },
  }))
}
