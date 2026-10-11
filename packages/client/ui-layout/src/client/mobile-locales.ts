/** Phone connection feedback; navigation uses the shared common labels. */
export const en = {
  'connection.error': 'Disconnected — reconnect',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Reconnecting, reconnect now',
} satisfies Record<string, string>

/** Chinese phone feedback, complete against the English dictionary. */
export const zh = {
  'connection.error': '连接已断开，点击重连',
  'connection.connecting': '正在重新连接',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接已断开，立即重连',
  'connection.restart': '正在重新连接，立即重试',
} satisfies Record<keyof typeof en, string>
