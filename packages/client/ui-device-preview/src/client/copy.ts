/** Typed locale namespace owned by the Device Preview plugin. */
export const en = {
  title: 'Device preview',
  'guide.description': 'Preview a page at phone and tablet CSS sizes',
  desktopOnly: 'Live device preview is available in the desktop app. You can select images here.',
  phone: 'Phone', tablet: 'Tablet',
  'device.ios-phone': 'iOS phone', 'device.android-phone': 'Android phone',
  'device.ios-tablet': 'iOS tablet', 'device.android-tablet': 'Android tablet',
  device: 'Device', portrait: 'Portrait', landscape: 'Landscape', orientation: 'Orientation',
  preset: 'Preset size', custom: 'Custom size', width: 'Width', height: 'Height', apply: 'Apply size',
  'size.invalid': 'Enter whole CSS pixel values from {min} to {max}.',
  'size.bounds': '{min}–{max} CSS px',
  'dimensions': '{width} × {height} CSS px · {percent}%',
  fit: 'Fit to panel', actual: '100%', scale: 'Display scale',
  compare: 'Compare phone and tablet', single: 'Single device',
  'compare.hint': 'Start opens the same URL on both devices. Each page then navigates independently.',
  url: 'Page URL', 'url.placeholder': 'Enter an HTTP(S) address', start: 'Start preview', go: 'Go',
  back: 'Back', forward: 'Forward', reload: 'Reload', loading: 'Loading page', live: 'Live page', image: 'Image preview',
  'source': 'Preview source', 'empty': 'Enter a URL and choose Start preview, or select an image.',
  'image.select': 'Select image for {orientation}', 'image.remove': 'Remove image',
  'image.label': 'Image preview — noninteractive',
  'image.alt': '{name} — {orientation} image preview, noninteractive',
  'image.missing': 'Select a separate {orientation} image. Images are never rotated to simulate a responsive page.',
  'image.failed': 'This image could not be read. Select a PNG, JPEG, WebP, or GIF file.',
  'error.address': 'Enter a valid HTTP(S) address.',
  'error.load': 'The page could not load. Reload or select an image.',
  'error.approval': 'Page access needs approval in the desktop app.',
  'unavailable': 'Live preview is unavailable for this page. You can select an image.',
  'project.title': 'Project preview', 'project.stop': 'Stop project',
  'project.idle': 'Project is stopped',
  'project.starting': 'Launcher started — readiness not confirmed', 'project.running': 'Project was ready at opening',
  'project.error': 'Project operation failed', 'project.open': 'Use project URL',
  'project.external': 'External server — not managed', 'project.stopping': 'Stopping project',
  'stop.success': 'Preview launcher at {url} stopped.', 'stop.failed': 'Preview launcher at {url} could not be stopped. Try Stop again.',
  limitation: 'Visual device frames use Chromium, not Android, iOS or Safari simulation.',
} satisfies Record<string, string>

/** Device preview dictionary keys. */
export type DevicePreviewKey = keyof typeof en
/** Chinese dictionary, with identical parameter templates and keys. */
export const zh = {
  title: '设备预览',
  'guide.description': '以手机和平板的 CSS 尺寸预览页面',
  desktopOnly: '实时设备预览仅在桌面应用中可用。你可以在此选择图片',
  phone: '手机', tablet: '平板',
  'device.ios-phone': 'iOS 手机', 'device.android-phone': 'Android 手机',
  'device.ios-tablet': 'iOS 平板', 'device.android-tablet': 'Android 平板',
  device: '设备', portrait: '竖屏', landscape: '横屏', orientation: '方向',
  preset: '预设尺寸', custom: '自定义尺寸', width: '宽度', height: '高度', apply: '应用尺寸',
  'size.invalid': '请输入 {min} 到 {max} 之间的整数 CSS 像素值',
  'size.bounds': '{min}–{max} CSS 像素',
  dimensions: '{width} × {height} CSS 像素 · {percent}%',
  fit: '适应面板', actual: '100%', scale: '显示缩放',
  compare: '对比手机和平板', single: '单设备',
  'compare.hint': '开始预览会在两台设备打开同一 URL，之后各自独立导航',
  url: '页面 URL', 'url.placeholder': '输入 HTTP(S) 地址', start: '开始预览', go: '前往',
  back: '后退', forward: '前进', reload: '刷新', loading: '正在加载页面', live: '实时页面', image: '图片预览',
  source: '预览来源', empty: '输入 URL 并选择开始预览，或选择图片',
  'image.select': '选择{orientation}图片', 'image.remove': '移除图片',
  'image.label': '图片预览 — 不可交互',
  'image.alt': '{name} — {orientation}图片预览，不可交互',
  'image.missing': '请另选一张{orientation}图片。不会旋转图片来模拟响应式页面',
  'image.failed': '无法读取此图片。请选择 PNG、JPEG、WebP 或 GIF 文件',
  'error.address': '请输入有效的 HTTP(S) 地址',
  'error.load': '无法加载页面，请刷新或选择图片',
  'error.approval': '页面访问需要在桌面应用中批准',
  unavailable: '此页面不支持实时预览，你可以选择图片',
  'project.title': '项目预览', 'project.stop': '停止项目',
  'project.idle': '项目已停止',
  'project.starting': '启动程序已启动 — 尚未确认就绪', 'project.running': '打开预览时项目已就绪',
  'project.error': '项目操作失败', 'project.open': '使用项目 URL',
  'project.external': '外部服务器 — 不受管理', 'project.stopping': '正在停止项目',
  'stop.success': '{url} 的预览启动程序已停止。', 'stop.failed': '无法停止 {url} 的预览启动程序，请再次选择停止。',
  limitation: '设备外观预览使用 Chromium，不模拟 Android、iOS 或 Safari',
} satisfies Record<DevicePreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Device preview controls, hardware labels and image fallback. */
    devicePreview: DevicePreviewKey
  }
}
