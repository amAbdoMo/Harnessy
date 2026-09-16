/**
 * Model-catalog projection behind the Subagents page's model and effort picker.
 *
 * Which catalog a picker draws from is decided by the backend the role names.
 * A backend whose routes resolve through Harnessy is served by the Host's own
 * `session.modelCatalog()` answer, so a provider or model added to a deployment
 * appears here with no Subagents-side change. A backend that owns its own model
 * space — a command-line tool with its own catalog — is served by that
 * backend's own listing, because the composed runtime has no adapter for a
 * model it is not the one to run.
 *
 * Four rules the picker cannot state for itself live here as pure functions:
 * which catalog a backend's routes belong to, how one backend's own listing
 * becomes the picker's rows together with the reasoning levels that backend
 * accepts, and that a route saved against a model the current source does not
 * advertise stays visible so the user can still remove it.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/catalog
 */

import type {
  CommandCodeCatalog,
  ModelCatalogModel,
  ModelProviderGroup,
  ModelReasoningEffort,
  SubagentModelPolicy,
  SubagentModelRoute,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SUBAGENT_BACKEND_DEFAULT_EFFORT } from './backends.ts'
import { COMMAND_CODE_BACKEND } from './contract.ts'

/**
 * Select value standing for "the agent chooses from the authorized routes".
 * A route key always carries the NUL separator {@link subagentModelKey}
 * inserts, so no real route can collide with this literal.
 */
export const SUBAGENT_MODEL_AUTOMATIC_SELECTION = 'automatic'

/** One model route the picker offers, joined with the route a definition stores. */
export interface SubagentModelChoice {
  /** Stable opaque identity used for lookup inside the picker. */
  key: string
  /** Adapter-owned provider id, as stored on a route. */
  provider: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model id, as stored on a route. */
  model: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current catalog advertises this exact route. */
  available: boolean
  /** Reasoning efforts this model advertises; empty when it advertises none. */
  efforts: readonly ModelReasoningEffort[]
}

/** Which catalog one role's routes belong to. */
export type SubagentCatalogOwner = 'runtime' | 'backend'

/** How far one catalog source's read has got. */
export type SubagentCatalogState = 'loading' | 'ready' | 'error'

/** The catalog one role's picker draws from, and how far that read has got. */
export interface SubagentModelSource {
  /** Backend the role routes to, as its `execution.backend` stores it. */
  readonly backend: string
  /** Whether that backend's routes resolve through Harnessy's runtime or its own model space. */
  readonly owner: SubagentCatalogOwner
  /** How far this source's read has got. */
  readonly state: SubagentCatalogState
}

/**
 * Which model space one backend's routes live in.
 *
 * A backend that owns its model space answers with its own catalog; every other
 * backend's routes resolve through the composed Harnessy runtime and are read
 * from the Host's model catalog.
 * @param backend - the backend a role's execution settings name.
 * @returns `backend` when the backend owns its model space, `runtime` otherwise.
 */
export function subagentCatalogOwner(backend: string): SubagentCatalogOwner {
  return backend === COMMAND_CODE_BACKEND ? 'backend' : 'runtime'
}

/**
 * Project one backend-owned catalog into the picker's provider groups.
 *
 * A Command Code model id is the CLI's own opaque identifier, and the backend
 * passes it to the CLI verbatim: an id shaped `<vendor>/<name>` is ONE id, not
 * a vendor and a model. Splitting it here would store a truncated id that the
 * CLI is then asked for, so the whole id is the route's model and the backend
 * that owns that model space is its provider — the same projection the roster's
 * migration of the pre-roster lanes applies, so a migrated role's stored route
 * reads back as this catalog's own entry rather than as an unavailable leftover.
 *
 * The listing states no reasoning levels, so every projected model carries the
 * vocabulary instead: those levels belong to the backend, and one of them is
 * what the picker offers for any route in this space.
 * @param catalog - the backend's catalog as the Host serves it.
 * @param backend - the backend name that owns this model space.
 * @param vocabulary - the reasoning efforts that backend accepts, as the page
 * spells their labels.
 * @returns one provider group for the backend, in listing order.
 */
export function commandCodeModelGroups(
  catalog: CommandCodeCatalog,
  backend: string,
  vocabulary: readonly ModelReasoningEffort[],
): ModelProviderGroup[] {
  // The vocabulary's own default means "ask for no level", which the picker's
  // model-default option already answers; a level listed here would instead be
  // stored as the literal id the backend reserves for its absence.
  const efforts = vocabulary.filter(effort => effort.id !== SUBAGENT_BACKEND_DEFAULT_EFFORT)
  const models: ModelCatalogModel[] = catalog.models.map(entry => ({
    id: entry.id,
    name: entry.id,
    ...efforts.length === 0 ? {} : { reasoning: { efforts } },
  }))
  return models.length === 0 ? [] : [{ id: backend, name: backend, models }]
}

/** The picker's route list, split into what the catalog advertises and what it does not. */
export interface SubagentModelDirectory {
  /** Provider groups the catalog advertises, in catalog order. */
  groups: readonly SubagentModelChoiceGroup[]
  /** Routes a definition stores that the catalog no longer advertises. */
  unavailable: readonly SubagentModelChoice[]
}

/** One advertised provider and the models the catalog lists under it. */
export interface SubagentModelChoiceGroup {
  /** Adapter-owned provider id. */
  provider: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** The provider's advertised models. */
  choices: SubagentModelChoice[]
}

/**
 * Stable identity for one exact route.
 * @param route - provider/model route to identify.
 * @returns the opaque key the picker compares selections by.
 */
export function subagentModelKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Join the live catalog with every route a definition stores, so a route whose
 * provider or model disappeared stays listed and removable instead of being
 * silently dropped from the picker.
 * @param groups - catalog groups as the Host serves them.
 * @param stored - routes stored by the document being edited.
 * @returns one row per advertised or stored route.
 */
export function subagentModelChoices(
  groups: readonly ModelProviderGroup[],
  stored: readonly SubagentModelRoute[],
): SubagentModelChoice[] {
  const storedByKey = new Map(stored.map(route => [subagentModelKey(route), route]))
  const choices = groups.flatMap(group => group.models.map((model): SubagentModelChoice => {
    storedByKey.delete(subagentModelKey({ provider: group.id, model: model.id }))
    return {
      key: subagentModelKey({ provider: group.id, model: model.id }),
      provider: group.id,
      providerName: group.name,
      model: model.id,
      modelName: model.name,
      available: true,
      efforts: model.reasoning?.efforts ?? [],
    }
  }))
  for (const route of storedByKey.values()) {
    choices.push({
      ...route,
      key: subagentModelKey(route),
      providerName: route.provider,
      modelName: route.model,
      available: false,
      efforts: [],
    })
  }
  return choices
}

/**
 * Split the joined rows into the advertised groups and the stored-but-gone routes.
 * @param choices - rows from {@link subagentModelChoices}.
 * @returns the groups to render, in catalog order, plus the removable leftovers.
 */
export function subagentModelDirectory(choices: readonly SubagentModelChoice[]): SubagentModelDirectory {
  const groups = new Map<string, SubagentModelChoiceGroup>()
  const unavailable: SubagentModelChoice[] = []
  for (const choice of choices) {
    if (!choice.available) {
      unavailable.push(choice)
      continue
    }
    const group = groups.get(choice.provider)
    if (group === undefined) {
      groups.set(choice.provider, {
        provider: choice.provider,
        providerName: choice.providerName,
        choices: [choice],
      })
    } else {
      group.choices.push(choice)
    }
  }
  return { groups: [...groups.values()], unavailable }
}

/** The select value a model policy renders as. */
function selectionOf(policy: SubagentModelPolicy | undefined): string {
  if (policy === undefined) return ''
  if (policy.mode === 'automatic') return SUBAGENT_MODEL_AUTOMATIC_SELECTION
  return policy.route === undefined ? '' : subagentModelKey(policy.route)
}

/**
 * The value one definition's model control renders for its stored policy.
 * @param policy - the stored model policy, absent when the definition names none.
 * @returns `''` for inherit, the automatic sentinel, or the pinned route's key.
 */
export function subagentModelSelection(policy: SubagentModelPolicy | undefined): string {
  return selectionOf(policy)
}

/**
 * The display name of one stored route.
 * @param choices - rows from {@link subagentModelChoices}.
 * @param route - the stored route.
 * @returns the catalog display name, or `provider/model` when the catalog does not list it.
 */
export function subagentModelName(
  choices: readonly SubagentModelChoice[],
  route: SubagentModelRoute,
): string {
  const key = subagentModelKey(route)
  const choice = choices.find(candidate => candidate.key === key)
  return choice === undefined ? `${route.provider}/${route.model}` : choice.modelName
}

/**
 * Read the reasoning efforts a policy's pinned model actually advertises.
 * @param choices - rows from {@link subagentModelChoices}.
 * @param policy - the stored model policy.
 * @returns the advertised efforts, empty when no route is pinned or the model advertises none.
 */
export function subagentEfforts(
  choices: readonly SubagentModelChoice[],
  policy: SubagentModelPolicy | undefined,
): readonly ModelReasoningEffort[] {
  if (policy === undefined || policy.route === undefined) return []
  const key = subagentModelKey(policy.route)
  return choices.find(choice => choice.key === key)?.efforts ?? []
}

/**
 * The display name of one route's pinned reasoning effort.
 *
 * An effort the current catalog no longer lists still renders as its stored id:
 * the route is real, and hiding the level would misreport what a delegation uses.
 * @param choices - rows from {@link subagentModelChoices}.
 * @param route - the pinned route.
 * @returns the advertised effort name, the stored id when it is not advertised, or undefined when none is pinned.
 */
export function subagentEffortName(
  choices: readonly SubagentModelChoice[],
  route: SubagentModelRoute | undefined,
): string | undefined {
  const effort = route?.reasoningEffort
  if (route === undefined || effort === undefined || effort.length === 0) return undefined
  const key = subagentModelKey(route)
  const advertised = choices.find(candidate => candidate.key === key)?.efforts ?? []
  return advertised.find(candidate => candidate.id === effort)?.name ?? effort
}

/**
 * Resolve one model selection into the policy to store.
 *
 * Selecting a different model re-narrows the effort list: an effort the newly
 * selected model does not advertise is cleared rather than carried over, so the
 * stored route never names a level the model cannot be asked for.
 * @param choices - rows from {@link subagentModelChoices}.
 * @param current - the policy the control currently shows.
 * @param selection - `''` for inherit, the automatic sentinel, or a route key.
 * @returns the policy this selection stores.
 */
export function selectSubagentModel(
  choices: readonly SubagentModelChoice[],
  current: SubagentModelPolicy | undefined,
  selection: string,
): SubagentModelPolicy {
  if (selection === '') return { mode: 'fixed' }
  if (selection === SUBAGENT_MODEL_AUTOMATIC_SELECTION) return { mode: 'automatic' }
  const choice = choices.find(candidate => candidate.key === selection)
  // A selection the picker never offered writes nothing usable; keeping the
  // current policy makes the control inert rather than storing a phantom route.
  if (choice === undefined) return current ?? { mode: 'fixed' }
  const carried = current?.route?.reasoningEffort
  const advertised = carried !== undefined && choice.efforts.some(candidate => candidate.id === carried)
  return {
    mode: 'fixed',
    route: {
      provider: choice.provider,
      model: choice.model,
      ...carried === undefined || !advertised ? {} : { reasoningEffort: carried },
    },
  }
}

/**
 * Store one reasoning effort on a pinned route.
 * @param route - the pinned route.
 * @param effortId - the advertised effort id, or `''` to use the model's own default.
 * @returns the route with that effort, or without an effort when the default was chosen.
 */
export function withSubagentEffort(route: SubagentModelRoute, effortId: string): SubagentModelRoute {
  return effortId === ''
    ? { provider: route.provider, model: route.model }
    : { provider: route.provider, model: route.model, reasoningEffort: effortId }
}
