/** Locale-owned notification copy shared by in-app and native presentation. */

import type { AccountAutoSwitchEvent, AccountUsageScope } from '@deepseek-ai/dsh-api-remotes/client'
import type { BrandKey } from './locales.ts'
import type { HarnessNotificationEvent } from './notification-history.ts'

/** Translated title and message for one notification event. */
export interface NotificationPresentation {
  readonly title: string
  readonly message: string
}

/**
 * Decide whether an event should also reach the native desktop surface.
 * @param event - event already retained by the in-app notification center.
 * @param pageIsForeground - whether the Harnessy document is visible and focused.
 * @returns true when the native bridge should receive the event.
 */
export function shouldShowNativeNotification(
  event: HarnessNotificationEvent,
  pageIsForeground: boolean,
): boolean {
  return event.kind !== 'task-completed' || !pageIsForeground
}

type Translate = (key: BrandKey) => string

/**
 * Resolve display copy for one notification event.
 * @param event - event to present.
 * @param t - bound Harnessy locale lookup.
 * @returns translated title and message.
 */
export function notificationPresentation(
  event: HarnessNotificationEvent,
  t: Translate,
): NotificationPresentation {
  switch (event.kind) {
    case 'account-switch':
      return {
        title: t('notificationsSwitchTitle'),
        message: t('notificationsSwitchMessage')
          .replace('{from}', partyLabel(event.from, t))
          .replace('{limit}', event.limit)
          .replace('{to}', partyLabel(event.to, t)),
      }
    case 'task-completed':
      return sessionPresentation('notificationsTaskCompletedTitle', 'notificationsTaskCompletedMessage', event.sessionTitle, t)
    case 'task-stopped':
      return sessionPresentation('notificationsTaskStoppedTitle', 'notificationsTaskStoppedMessage', event.sessionTitle, t)
    case 'task-failed':
      return sessionPresentation('notificationsTaskFailedTitle', 'notificationsTaskFailedMessage', event.sessionTitle, t)
    case 'approval-required':
      return sessionPresentation('notificationsApprovalTitle', 'notificationsApprovalMessage', event.sessionTitle, t)
    case 'question-required':
      return sessionPresentation('notificationsQuestionTitle', 'notificationsQuestionMessage', event.sessionTitle, t)
    case 'plan-review-required':
      return sessionPresentation('notificationsPlanReviewTitle', 'notificationsPlanReviewMessage', event.sessionTitle, t)
    case 'mcp-connection-failed':
      return {
        title: t('notificationsMcpFailedTitle'),
        message: t('notificationsMcpFailedMessage').replace('{server}', event.serverName),
      }
    case 'mcp-connection-recovered':
      return {
        title: t('notificationsMcpRecoveredTitle'),
        message: t('notificationsMcpRecoveredMessage').replace('{server}', event.serverName),
      }
  }
}

function sessionPresentation(
  titleKey: BrandKey,
  messageKey: BrandKey,
  sessionTitle: string,
  t: Translate,
): NotificationPresentation {
  return {
    title: t(titleKey),
    message: t(messageKey).replace('{session}', sessionTitle),
  }
}

function partyLabel(party: AccountAutoSwitchEvent['from'], t: Translate): string {
  const scope = party.usageScope === undefined ? undefined : scopeLabel(party.usageScope, t)
  return scope === undefined ? party.name : `${party.name} (${scope})`
}

function scopeLabel(scope: AccountUsageScope, t: Translate): string {
  return scope === 'workspace' ? t('accountsUsageWorkspace') : t('accountsUsagePersonal')
}
