/**
 * Composer model selector.
 *
 * A normal model click stages it; a normal effort click submits the pair.
 * Double-clicking either column changes only that value, so a single effort
 * click is briefly deferred until the double-click gesture has resolved.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import clsx from 'clsx'
import type {
  ModelCatalogModel, ModelProviderGroup, ModelReasoningEffort, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconCloseOutline16,
  IconDataOutline16, IconSearchOutline16, IconWarningOutline16,
  Input, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

interface ModelChoice {
  key: string
  group: ModelProviderGroup
  model: ModelCatalogModel
}

interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

const SINGLE_CLICK_DELAY_MS = 230
const choiceKey = (provider: string, model: string): string => `${provider}\u0000${model}`

/** Render the composer's model-and-effort control. */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draftKey, setDraftKey] = useState<string | null>(null)
  const [draftEffort, setDraftEffort] = useState<string | undefined>()
  const [modelArmed, setModelArmed] = useState(false)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const pendingEffortRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const id = useId()

  const choices = useMemo<readonly ModelChoice[]>(() => state.groups.flatMap(group =>
    group.models.map(model => ({ key: choiceKey(group.id, model.id), group, model }))), [state.groups])
  const current = state.current
  const currentChoice = current === null
    ? undefined
    : choices.find(choice => choice.key === choiceKey(current.provider, current.model))
  const currentReasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? currentReasoning?.defaultEffort
  const currentEffortLabel = currentReasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : currentReasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const draftChoice = choices.find(choice => choice.key === draftKey)

  const effortChoices = useMemo<readonly EffortChoice[]>(() => {
    const reasoning = draftChoice?.model.reasoning
    if (reasoning === undefined) return []
    return [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ]
  }, [draftChoice, t])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredGroups = useMemo(() => state.groups.map(group => ({
    group,
    models: group.models.filter(model => normalizedQuery === '' ||
      `${group.name} ${group.id} ${model.name} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery)),
  })).filter(entry => entry.models.length > 0), [normalizedQuery, state.groups])

  const busy = state.status === 'selecting'
  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = currentEffortLabel === undefined ? modelLabel : `${modelLabel} · ${currentEffortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : currentEffortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: currentEffortLabel })

  const clearPendingEffort = (): void => {
    if (pendingEffortRef.current === null) return
    clearTimeout(pendingEffortRef.current)
    pendingEffortRef.current = null
  }

  useEffect(() => () => { clearPendingEffort() }, [])

  if (!available) return null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  const close = (restoreFocus = false): void => {
    clearPendingEffort()
    setOpen(false)
    setQuery('')
    setModelArmed(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const show = (): void => {
    clearPendingEffort()
    setQuery('')
    setDraftKey(currentChoice?.key ?? choices[0]?.key ?? null)
    setDraftEffort(effectiveEffort)
    setModelArmed(false)
    setOpen(true)
    // The shared service preloads this catalog. Avoid another request when a
    // resident result exists so the dialog opens immediately.
    if (state.status === 'idle' || state.status === 'error') reload()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const submit = (selection: ModelSelection): void => {
    clearPendingEffort()
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const selectionFor = (choice: ModelChoice, effort: string | undefined): ModelSelection => ({
    provider: choice.group.id,
    model: choice.model.id,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  })

  const chooseModelOnly = (choice: ModelChoice): void => {
    const reasoning = choice.model.reasoning
    const preserved = state.current?.reasoningEffort
    const effort = preserved !== undefined && reasoning?.efforts.some(level => level.id === preserved) === true
      ? preserved
      : reasoning?.defaultEffort
    submit(selectionFor(choice, effort))
  }

  const stageModel = (choice: ModelChoice): void => {
    clearPendingEffort()
    setDraftKey(choice.key)
    setDraftEffort(choice.model.reasoning?.defaultEffort)
    setModelArmed(true)
    if (choice.model.reasoning === undefined) submit(selectionFor(choice, undefined))
  }

  const choosePairAfterClick = (effort: string | undefined): void => {
    clearPendingEffort()
    setDraftEffort(effort)
    if (!modelArmed || draftChoice === undefined) return
    pendingEffortRef.current = setTimeout(() => {
      pendingEffortRef.current = null
      submit(selectionFor(draftChoice, effort))
    }, SINGLE_CLICK_DELAY_MS)
  }

  const chooseEffortOnly = (effort: string | undefined): void => {
    clearPendingEffort()
    if (state.current === null || currentChoice === undefined) return
    const supported = effort === undefined || currentChoice.model.reasoning?.efforts.some(level => level.id === effort) === true
    if (!supported) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.effortUnavailable') })
      return
    }
    submit({
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  }

  const draftEffortLabel = effortChoices.find(level => level.effort === draftEffort)?.label
  const draftLabel = draftChoice === undefined
    ? triggerLabel
    : `${draftChoice.model.name}${draftEffortLabel === undefined ? '' : ` · ${draftEffortLabel}`}`

  return (
    <div ref={rootRef} className={css.root}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
        disabled={locked}
        onClick={() => { if (open) close(); else show() }}
      >
        <IconDataOutline16 className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {currentEffortLabel !== undefined && <span className={css.triggerEffort}>{currentEffortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      <Modal open={open} onClose={() => { close(true) }} title={t('dialog.title')} className={css.dialog ?? ''} headless>
        <header className={css.dialogHeader}>
          <div className={css.dialogHeading}>
            <h2 className={css.dialogTitle}>{t('dialog.title')}</h2>
            <p className={css.dialogSubtitle}>{t('dialog.current', { selection: draftLabel })}</p>
          </div>
          <button type="button" className={css.close} aria-label={t('dialog.close')} onClick={() => { close(true) }}>
            <IconCloseOutline16 />
          </button>
        </header>

        <div className={css.dialogBody}>
          <section className={css.modelsPanel} aria-labelledby={`${id}-models-title`}>
            <h3 className={css.panelTitle} id={`${id}-models-title`}>{t('dialog.models')}</h3>
            <Input
              className={css.search ?? ''}
              icon={<IconSearchOutline16 />}
              value={query}
              aria-label={t('dialog.searchAria')}
              placeholder={t('dialog.search')}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            {state.status === 'loading' && choices.length === 0 && <div className={css.status}>{t('status.loading')}</div>}
            {state.error !== null && lastActionRef.current === 'load' && (
              <div className={css.error}>
                <span>{t('error.action', { message: state.error })}</span>
                <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
              </div>
            )}
            {state.failures.map(failure => (
              <div className={css.warning} key={failure.id}>
                <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
              </div>
            ))}
            <div className={clsx(css.modelList, 'scrollable')} role="listbox" aria-label={t('dialog.models')}>
              {filteredGroups.map(({ group, models }) => {
                const headingId = `${id}-${group.id}`
                return (
                  <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                    <div className={css.groupTitle} id={headingId}>{group.name}</div>
                    {models.map((model) => {
                      const key = choiceKey(group.id, model.id)
                      const choice: ModelChoice = { key, group, model }
                      const selected = draftKey === key
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={clsx(css.modelOption, selected && css.selected)}
                          key={model.id}
                          disabled={busy}
                          onClick={() => { stageModel(choice) }}
                          onDoubleClick={(event: ReactMouseEvent) => {
                            event.preventDefault()
                            chooseModelOnly(choice)
                          }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                            <span className={css.modelId}>{model.id}</span>
                          </span>
                          {selected && <IconCheckOutline16 className={css.check} />}
                        </button>
                      )
                    })}
                  </section>
                )
              })}
              {state.status === 'ready' && choices.length === 0 && <div className={css.empty}>{t('empty.models')}</div>}
              {choices.length > 0 && filteredGroups.length === 0 && <div className={css.empty}>{t('empty.search')}</div>}
            </div>
          </section>

          <section className={css.effortPanel} aria-labelledby={`${id}-effort-title`}>
            <h3 className={css.panelTitle} id={`${id}-effort-title`}>{t('dialog.effort')}</h3>
            <p className={css.panelHelp}>{t('dialog.effortHelp')}</p>
            <div className={css.effortList} role="listbox" aria-label={t('dialog.effort')}>
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={draftEffort === level.effort}
                    className={clsx(css.effortOption, draftEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { choosePairAfterClick(level.effort) }}
                    onDoubleClick={(event: ReactMouseEvent) => {
                      event.preventDefault()
                      chooseEffortOnly(level.effort)
                    }}
                  >
                    <span>{level.label}</span>
                    {draftEffort === level.effort && <IconCheckOutline16 className={css.check} />}
                  </button>
                ))}
            </div>
          </section>
        </div>
        <p className={css.interactionHint}>{t('dialog.hint')}</p>
      </Modal>

      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
