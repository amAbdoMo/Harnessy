/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'dialog.title': '模型与推理等级',
  'dialog.current': '当前选择：{selection}',
  'dialog.close': '关闭模型选择器',
  'dialog.models': '可用模型',
  'dialog.effort': '推理等级',
  'dialog.effortHelp': '选择此模型使用的思考深度。',
  'dialog.search': '搜索模型…',
  'dialog.searchAria': '搜索可用模型',
  'dialog.hint': '单击模型后再单击推理等级以同时应用。双击任意一项仅更改该项。',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.effortUnavailable': '当前模型不支持此推理等级。',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.search': '没有匹配的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'dialog.title': 'Model & thinking level',
  'dialog.current': 'Current selection: {selection}',
  'dialog.close': 'Close model picker',
  'dialog.models': 'Available models',
  'dialog.effort': 'Thinking level',
  'dialog.effortHelp': 'Choose how deeply this model should think.',
  'dialog.search': 'Search models…',
  'dialog.searchAria': 'Search available models',
  'dialog.hint': 'Click a model, then a level to apply both. Double-click either item to change only it.',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.effortUnavailable': 'This thinking level is unavailable for the current model.',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.search': 'No matching models.',
  'blocked.composer': 'This model is unavailable — select one to continue',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
