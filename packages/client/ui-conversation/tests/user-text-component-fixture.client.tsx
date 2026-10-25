/** Production text evaluation with Harnessy's existing ordinary-text presentation. */
import { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import { onTestFinished } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { projectUserText, type UserTextReferences } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuotedUserText } from '@deepseek-ai/dsh-message-quotes/src/client/QuotedUserText.tsx'
import { quoteRule } from '@deepseek-ai/dsh-message-quotes/src/client/quote-rule.ts'
import type { UserTextInput, UserTextNodeOwnerProps } from '../src/client/contract/slots.ts'
import type { UserTextNode } from '../src/client/contract/user-text.ts'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'
import { UserText, PlainUserText, SessionReference } from '../src/client/user-text/UserText.tsx'
import { sessionReferenceRule } from '../src/client/user-text/session-reference-rule.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '../src/client/user-text/whitespace-rules.ts'

type FixtureInput = UserTextInput & { readonly facts: UserTextInput['facts'] & { readonly skillNames?: readonly string[] } }
type UserTextProps = ComponentProps<typeof UserText>

/**
 * Bind production matching and quote rendering without changing Harnessy's ordinary reference owner.
 * @param references - optional file and skill navigation for interactive fixtures.
 * @returns a renderer using the production text components and independently owned evaluator.
 */
export function createUserTextFixture(references?: UserTextReferences): (input: FixtureInput) => ReactNode {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of [sessionReferenceRule, collapseWhitespaceRule, trimWhitespaceRule, quoteRule]) registry.register(rule)
  const useUserTextRevision = bindSnapshotSelector(registry)
  const createUserTextEvaluator = () => registry.createEvaluator()
  const renderSlot = ((_name: 'conversation.user.text.node', props: UserTextNodeOwnerProps & { readonly node: UserTextNode },
    options?: { fallback?: ReactNode }) => {
    switch (props.node.id) {
      case 'quote': return <QuotedUserText {...props} node={props.node} />
      case 'session': return <SessionReference {...props} node={props.node} />
      case 'text': return <PlainUserText {...props} node={props.node} />
      default: return options?.fallback ?? null
    }
  }) as UserTextProps['renderSlot']
  return input => createElement(UserText, {
    ...input, useUserTextRevision, createUserTextEvaluator, renderSlot,
    renderText: input.renderText ?? (text => projectUserText(
      text, input.facts.sessionLabels ?? [], input.facts.skillNames ?? [], 'skill', input.interactive ? references : undefined,
    )),
    reportTransformFailure: (error: unknown) => { throw error },
  } as UserTextProps)
}
