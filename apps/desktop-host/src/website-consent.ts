/** Fixed per-operation warnings; browser fallback and site changes require a fresh one-call decision. */
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** A caller cannot replace the operation warning with model-provided copy. */
export type WebsiteBrowserConsent =
  | { readonly operation: 'page-info' }
  | { readonly operation: 'dom' | 'screenshot' | 'click' | 'fill' | 'navigate' | 'evaluate'; readonly fallbackReason: string; readonly details?: string }

/**
 * @param consent - exact browser operation and, except for title/origin, the reason MCP cannot perform the task.
 * @returns a one-call warning naming disclosure or mutation and explicitly requesting browser fallback permission.
 */
export function websiteBrowserConsentReason(consent: WebsiteBrowserConsent): string {
  if (consent.operation === 'page-info') {
    return 'Read the current page title and origin from the approved website/account browser. This may disclose sensitive page-title text; no page body, login state or full URL will be read. This permission applies only to this call.'
  }
  if (consent.fallbackReason.trim() === '' || Buffer.byteLength(consent.fallbackReason, 'utf8') > 512
    || /[\p{Cc}\p{Cf}]/u.test(consent.fallbackReason)) {
    throw new Error('Browser fallback requires a nonempty reason of at most 512 UTF-8 bytes without control characters')
  }
  if (consent.details !== undefined && Buffer.byteLength(consent.details) > 64 * 1024) throw new Error('Website operation consent details exceeded the byte limit')
  const details = consent.details === undefined ? '' : ` Requested operation: ${consent.details}.`
  const warning = operationWarning(consent.operation)
  return `Allow browser fallback instead of the paired MCP for this call? Stated reason: ${JSON.stringify(consent.fallbackReason)}. ${warning}${details} Approve only if you intend this exact operation. Permission applies only to this call; it does not confirm that the website completed an action. Never approve access to passwords, verification codes or authentication secrets.`
}

function operationWarning(operation: Exclude<WebsiteBrowserConsent['operation'], 'page-info'>): string {
  switch (operation) {
    case 'dom': return 'Read bounded visible page text. This may disclose sensitive website content.'
    case 'screenshot': return 'Capture the current page viewport and store the image in this conversation. This may disclose sensitive visible content.'
    case 'click': return 'Click one page element. This can submit, publish, delete, purchase or otherwise irreversibly change the website.'
    case 'fill': return 'Replace text in one non-authentication field. Page event handlers can immediately save or submit changes.'
    case 'navigate': return 'Navigate the same website guest. This can discard unsaved changes and the destination may perform a site action.'
    case 'evaluate': return 'Execute the supplied JavaScript in the website. This can read sensitive content and perform arbitrary, irreversible site actions; there is no read-only sandbox. The script is retained in the conversation.'
    default: return assertNever(operation)
  }
}
