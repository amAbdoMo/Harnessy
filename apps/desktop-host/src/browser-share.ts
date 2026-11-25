/** Authenticated browser viewer and share revocation on the private Web connection. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { DesktopRemoteConnection } from './remote-connection.ts'

const PATH = '/api/browser-share'
const MAX_FRAME_BYTES = 512 * 1024
const VIEW_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function viewer(request: Request): Response {
  const nonce = randomUUID()
  const chinese = /^zh\b/i.test(request.headers.get('accept-language') ?? '')
  const copy = chinese
    ? { title: 'Harnessy 浏览器共享', waiting: '正在连接共享浏览器…', ended: '浏览器共享已结束。', frame: '共享的浏览器画面',
      stop: '停止共享', stopFailed: '无法停止共享，请重试。' }
    : { title: 'Harnessy browser share', waiting: 'Connecting to the shared browser…', ended: 'Browser sharing ended.',
      frame: 'Shared browser view', stop: 'Stop sharing', stopFailed: 'Couldn’t stop sharing. Try again.' }
  const page = `<!doctype html><html lang="${chinese ? 'zh' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title>
<style nonce="${nonce}">html{color-scheme:dark light;font:16px system-ui}body{margin:0;display:grid;min-height:100dvh;place-content:center;text-align:center}img{display:block;max-width:100vw;max-height:calc(100dvh - 76px);object-fit:contain}img[hidden]{display:none}p{margin:1rem}button{justify-self:center;min-height:44px;margin:12px;padding:0 16px;font:inherit}</style></head>
<body><p id="status" role="status" data-ended="${copy.ended}" data-failed="${copy.stopFailed}">${copy.waiting}</p>
<img id="screen" alt="${copy.frame}" hidden><button id="stop" type="button" hidden>${copy.stop}</button>
<script nonce="${nonce}">
const statusLine = document.getElementById('status');
const image = document.getElementById('screen');
const stop = document.getElementById('stop');
const share = new URL(location.href);
const source = new URL(share);
source.searchParams.set('frame', '1');
const life = new AbortController();
const waiting = statusLine.textContent;
let current;
function clearFrame() {
  if (current) URL.revokeObjectURL(current);
  current = undefined;
  image.removeAttribute('src');
  image.hidden = true;
}
function end() {
  life.abort(); clearFrame(); stop.hidden = true;
  statusLine.textContent = statusLine.dataset.ended; statusLine.hidden = false;
}
stop.addEventListener('click', async () => {
  stop.disabled = true;
  try {
    const result = await fetch(share, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      referrer: share.origin + '/', referrerPolicy: 'same-origin' });
    if (result.status === 204 || result.status === 410) { end(); return; }
  } catch (error) { if (life.signal.aborted) return; }
  if (life.signal.aborted) return;
  stop.disabled = false;
  statusLine.textContent = statusLine.dataset.failed; statusLine.hidden = false;
});
addEventListener('pagehide', () => { life.abort(); clearFrame(); }, { once: true });
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function next() {
  try {
    const response = await fetch(source, { signal: life.signal, credentials: 'same-origin', cache: 'no-store' });
    if (life.signal.aborted) return;
    if (response.status !== 204) {
      if (!response.ok || response.headers.get('content-type') !== 'image/jpeg') { end(); return; }
      const frame = await response.blob();
      if (life.signal.aborted) return;
      if (current) URL.revokeObjectURL(current);
      current = URL.createObjectURL(frame);
      image.src = current;
      image.hidden = false;
      stop.hidden = false;
      if (statusLine.textContent === waiting) statusLine.hidden = true;
    }
    setTimeout(next, 250);
  } catch { if (!life.signal.aborted) end(); }
}
void next();
</script></body></html>`
  return new Response(page, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` } })
}

/**
 * Register the viewer on the authenticated Connection route registry.
 * @param ctx - Desktop Host lifecycle owner.
 * @param remote - configured private HTTPS authority.
 * @param send - this Host's Main IPC sender.
 * @returns Receiver for share responses and cancellation on Host disconnect.
 */
export function installBrowserShare(ctx: Context, remote: DesktopRemoteConnection, send: (message: object) => Promise<void>): {
  receive(input: unknown): boolean
  close(): void
} {
  let closed = false
  const pending = new Map<'frame' | 'stop', { readonly requestId: string; readonly complete: (response: Response) => void }>()
  const unavailable = (): Response => new Response(null, { status: 410, headers })
  const empty = (): Response => new Response(null, { status: 204, headers })
  const failed = (): Response => new Response(null, { status: 503, headers })
  const origin = new URL(remote.remoteRoot).origin
  const close = (): void => { closed = true; for (const call of pending.values()) call.complete(failed()) }
  ctx.effect(() => close, 'browser share lifetime')
  ctx.connection.fetch.register({ path: PATH, methods: ['GET', 'POST'], requestBody: 'buffered', async fetch(request) {
    const host = request.headers.get('host')?.toLowerCase()
    if (closed || host !== remote.hostname && host !== `${remote.hostname}:443`) return new Response(null, { status: 404, headers })
    const query = new URL(request.url).searchParams
    const id = query.get('view')
    if (id === null || !VIEW_ID.test(id) || query.getAll('view').length !== 1) return unavailable()
    const operation = request.method === 'POST' ? 'stop' : 'frame'
    if (operation === 'stop') {
      if (request.headers.get('origin') !== origin || query.has('frame')) return new Response(null, { status: 403, headers })
    } else {
      if (!query.has('frame')) return viewer(request)
      if (query.get('frame') !== '1') return unavailable()
    }
    if (request.signal.aborted) return failed()
    if (pending.has(operation)) return operation === 'frame' ? empty() : new Response(null, { status: 429, headers })
    const requestId = randomUUID()
    const { promise, resolve } = Promise.withResolvers<Response>()
    const abort = (): void => { resolve(failed()) }
    pending.set(operation, { requestId, complete: resolve })
    request.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 3000)
    try {
      void send({ type: `browser-share-${operation}`, requestId, id }).catch(abort)
      return await promise
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
      pending.delete(operation)
    }
  } })
  return { close, receive(input) {
    if (typeof input !== 'object' || input === null || !('type' in input)) return false
    const operation = input.type === 'browser-share-stop-result' ? 'stop' : input.type === 'browser-share-frame-result' ? 'frame' : undefined
    if (operation === undefined) return false
    const call = pending.get(operation)
    if (call === undefined || !('requestId' in input) || input.requestId !== call.requestId) return true
    if (operation === 'stop') call.complete('status' in input && input.status === 'stopped' ? empty() : unavailable())
    else if ('status' in input && input.status === 'busy') call.complete(empty())
    else if ('status' in input && input.status === 'frame' && 'jpeg' in input && typeof input.jpeg === 'string'
      && input.jpeg.length <= Math.ceil(MAX_FRAME_BYTES / 3) * 4) {
      const jpeg = Uint8Array.from(Buffer.from(input.jpeg, 'base64'))
      if (jpeg.byteLength > 0 && jpeg.byteLength <= MAX_FRAME_BYTES) {
        call.complete(new Response(jpeg, { headers: { ...headers, 'content-type': 'image/jpeg' } }))
      } else call.complete(unavailable())
    } else call.complete(unavailable())
    return true
  } }
}
