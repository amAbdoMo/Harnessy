/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * The trigger opens one searchable dialog that keeps provider-grouped models
 * and the selected model's reasoning levels in one place. Selections use the
 * same per-session ModelDirectory as the `/model`
 * command, so either entry observes changes made by the other.
 */
import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconDataOutlineRegular,
  IconSearchOutlineRegular, IconWarningOutlineRegular, Input, Modal, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** One dynamic reasoning row; undefined preserves the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/**
 * Render the composer model control and its searchable model picker.
 * @param props - owner lock, shared directory operations, and locale.
 * @returns the trigger, dialog while open, and selection-error toast.
 */
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
  const [draft, setDraft] = useState<ModelSelection | null>(null)
  const [modelStaged, setModelStaged] = useState(false)
  const submittingRef = useRef(false)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const id = useId()

  const groups = useMemo(() => state.groups.toSorted((left, right) =>
    (left.id === 'deepseek-account' ? 0 : left.id === 'deepseek-official' ? 1 : 2)
      - (right.id === 'deepseek-account' ? 0 : right.id === 'deepseek-official' ? 1 : 2)), [state.groups])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(choice => choice.selection.provider === state.current?.provider
      && choice.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const currentReasoning = currentChoice?.model.reasoning
  const currentEffort = state.current?.reasoningEffort ?? currentReasoning?.defaultEffort
  const effortLabel = currentReasoning === undefined
    ? state.retainedEffort
    : currentEffort === undefined
      ? t('effort.providerDefault')
      : currentReasoning.efforts.find(level => level.id === currentEffort)?.name ?? currentEffort
  const pickerChoice = draft === null
    ? currentChoice
    : choices.find(choice => choice.selection.provider === draft.provider
      && choice.selection.model === draft.model)
  const pickerReasoning = pickerChoice?.model.reasoning
  const pickerEffort = draft?.reasoningEffort ?? pickerReasoning?.defaultEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => pickerReasoning === undefined
    ? []
    : [
      ...pickerReasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...pickerReasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [pickerReasoning, t])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group,
    models: group.models.filter(model => normalizedQuery === '' || [
      group.id, group.name, model.id, model.name, model.description ?? '',
    ].some(value => value.toLocaleLowerCase().includes(normalizedQuery))),
  })).filter(group => group.models.length > 0), [groups, normalizedQuery])
  const { pending } = state
  const busy = pending !== null

  if (!available) return null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }
  const show = (): void => {
    setQuery('')
    setDraft(state.current)
    setModelStaged(false)
    setOpen(true)
    reload()
  }
  const close = (): void => {
    setOpen(false)
    setDraft(null)
    setModelStaged(false)
  }
  const settleSelection = (
    result: Awaited<ReturnType<ModelSelectInjected['select']>>,
  ): void => {
    submittingRef.current = false
    if (result === undefined) return
    if (result.ok) {
      close()
      return
    }
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: result.error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${result.error.code}: ${result.error.message}` }),
    })
  }
  const isCurrent = (selection: ModelSelection): boolean => state.current?.provider === selection.provider
    && state.current.model === selection.model
    && state.current.reasoningEffort === selection.reasoningEffort
  const submit = (selection: ModelSelection): void => {
    if (busy || submittingRef.current) return
    if (isCurrent(selection)) {
      close()
      return
    }
    submittingRef.current = true
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }
  const stageModel = (selection: ModelSelection): void => {
    if (busy) return
    setDraft(selection)
    setModelStaged(true)
  }
  const selectionWithEffort = (effort: string | undefined): ModelSelection | null => draft === null
    ? null
    : {
      provider: draft.provider,
      model: draft.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
  const stageEffort = (effort: string | undefined): void => {
    if (busy) return
    const selection = selectionWithEffort(effort)
    if (selection === null) return
    setDraft(selection)
    if (modelStaged) submit(selection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  return (
    <div ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
        aria-busy={busy}
        disabled={locked}
        onClick={() => { if (open) close(); else show() }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      <Modal
        open={open}
        onClose={close}
        title={t('dialog.title')}
        closeLabel={t('dialog.close')}
        className={clsx(css.dialog)}
        contentClassName={clsx(css.dialogContent)}
      >
        <div className={css.dialogBody}>
          <section className={css.modelsPanel} aria-labelledby={`${id}-models`}>
            <h3 className={css.panelTitle} id={`${id}-models`}>{t('dialog.models')}</h3>
            <Input
              data-modal-autofocus
              className={clsx(css.search)}
              icon={<IconSearchOutlineRegular />}
              value={query}
              placeholder={t('dialog.search')}
              aria-label={t('dialog.searchAria')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
            {state.status === 'loading' && <div className={css.status}>{t('status.loading')}</div>}
            {state.error !== null && lastActionRef.current === 'load' && (
              <div className={css.error}>
                <span>{t('error.action', { message: state.error })}</span>
                <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
              </div>
            )}
            {state.failures.map(failure => (
              <div className={css.warning} key={failure.id}>
                <span>{t('warning.groupLoad', {
                  name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name,
                  message: failure.message,
                })}</span>
                <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
              </div>
            ))}
            <div className={clsx(css.modelList, 'scrollable')} role="radiogroup" aria-label={t('dialog.models')}>
              {filteredGroups.map((group) => {
                const headingId = `${id}-${group.id}`
                return (
                  <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                    <div className={css.groupTitle} id={headingId}>
                      {group.id === 'deepseek-account' ? t('provider.account') : group.name}
                    </div>
                    {group.models.map((model) => {
                      const selection = {
                        provider: group.id,
                        model: model.id,
                        ...model.reasoning?.defaultEffort === undefined
                          ? {}
                          : { reasoningEffort: model.reasoning.defaultEffort },
                      } satisfies ModelSelection
                      const selected = draft?.provider === group.id && draft.model === model.id
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={clsx(css.modelOption, selected && css.selected)}
                          key={model.id}
                          title={model.name}
                          aria-disabled={busy}
                          onClick={(event) => {
                            if (event.detail > 1) submit(selection)
                            else stageModel(selection)
                          }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                            <span className={css.modelId}>{group.name} · {model.id}</span>
                          </span>
                          <span className={css.check}>
                            {pending?.provider === group.id && pending.model === model.id
                              ? <StateDot state="ongoing" />
                              : selected ? <IconCheckOutlineRegular /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </section>
                )
              })}
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
              {state.status === 'ready' && choices.length > 0 && filteredGroups.length === 0 && (
                <div className={css.empty}>{t('empty.search')}</div>
              )}
            </div>
          </section>

          <section className={css.effortPanel} aria-labelledby={`${id}-effort`}>
            <h3 className={css.panelTitle} id={`${id}-effort`}>{t('dialog.effort')}</h3>
            <p className={css.panelHelp}>{t('dialog.effortHelp')}</p>
            <div className={css.effortList} role="radiogroup" aria-label={t('dialog.effort')}>
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pickerEffort === level.effort}
                    className={clsx(css.effortOption, pickerEffort === level.effort && css.selected)}
                    key={level.key}
                    aria-disabled={busy}
                    onClick={(event) => {
                      if (event.detail > 1) {
                        const selection = selectionWithEffort(level.effort)
                        if (selection !== null) submit(selection)
                      } else {
                        stageEffort(level.effort)
                      }
                    }}
                  >
                    <span>{level.label}</span>
                    <span className={css.check}>
                      {pending !== null && pending.provider === draft?.provider
                        && pending.model === draft.model && pending.reasoningEffort === level.effort
                        ? <StateDot state="ongoing" />
                        : pickerEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                    </span>
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
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
