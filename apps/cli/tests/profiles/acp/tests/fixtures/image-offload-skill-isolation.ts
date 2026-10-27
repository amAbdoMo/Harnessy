/** Hide the unrelated bundled Windows ACL skill in the image-offload scenario. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'image-offload-skill-isolation'
export const inject = ['skills']

/** @param ctx - assembled ACP composition for the image-offload scenario. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Platform ACL diagnosis is outside this image-offload scenario.',
    content: '',
    source: 'custom',
    invocation: { modelInvocable: false, userInvocable: false },
  }))
}
