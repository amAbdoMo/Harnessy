import type { MessageImagesProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'
import type { FileDragActions } from '@deepseek-ai/dsh-client-ui-primitives'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, compact = false, thumbnail = false, t, fileDrag }:
MessageImagesProps & { readonly fileDrag: FileDragActions }) {
  return (
    <ImageGallery
      images={images}
      load={loadImage}
      align={align}
      compact={compact}
      thumbnail={thumbnail}
      labels={messageImageLabels(t)}
      fileDrag={fileDrag}
    />
  )
}
