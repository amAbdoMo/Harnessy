/** Deterministic external model metadata and binary-storage providers; registry and batch admission remain real. */
import { createHash } from 'node:crypto'
import AttachmentStore, { AttachmentId, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Static one-pixel PNG from attachment-local's keyless storage fixture. */
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/** Test binary backend implementing the real AttachmentStore admission API. */
export class WebsiteTestAttachments extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1024 * 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024 * 1024,
    maxImagePixels: 2048 * 2048, maxImageDimension: 2048, mediaTypes: ['image/png'] as const }
  readonly images = new Map<string, Uint8Array>()
  readonly entered = Promise.withResolvers<undefined>()
  waitForStorage: Promise<void> = Promise.resolve()

  validateImage(input: SaveImageAttachment): Promise<void> {
    if (Buffer.from(input.data).toString('base64') !== TINY_PNG) throw new Error('Unexpected test raster')
    return Promise.resolve()
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.entered.resolve(undefined)
    await this.waitForStorage
    const attachmentId = AttachmentId(`sha256:${createHash('sha256').update(input.data).digest('hex')}`)
    this.images.set(attachmentId, input.data.slice())
    return { attachmentId, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
      ...input.name === undefined ? {} : { name: input.name } }
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const data = this.images.get(ref.attachmentId)
    if (data === undefined) throw new Error('Image was not committed')
    return Promise.resolve({ ref, data: data.slice() })
  }
}

/** Provider-owned metadata double; streaming is deliberately unavailable. */
export class WebsiteTestModels extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('These tests never call a live model')
  }
}
