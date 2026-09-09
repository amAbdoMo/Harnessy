/** Return a validated ordinary Web URL, or undefined for privileged/invalid input. */
export function externalWebUrl(candidateUrl) {
  try {
    const url = new URL(candidateUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Only the active loopback service may replace content in the privileged app window. */
export function isAllowedNavigation(candidateUrl, serviceOrigin) {
  try {
    const url = new URL(candidateUrl)
    if (url.protocol === 'file:') return serviceOrigin === undefined
    return serviceOrigin !== undefined && url.origin === serviceOrigin
  } catch {
    return false
  }
}
