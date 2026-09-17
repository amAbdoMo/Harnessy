/**
 * The bundled public capability snapshot: what one capture of the public model
 * databases stated, reduced to the reasoning-effort fields this layer resolves,
 * plus the metadata that makes the reduction auditable.
 *
 * The snapshot carries each catalog in the document form the resolver already
 * reads (`models.dev/api.json`, OpenRouter's `/api/v1/models`), so loading one
 * is a wrap and never a second reader. Curation is a whitelist re-encode: every
 * field this layer does not resolve is absent from the output, which is what
 * keeps upstream growth from enlarging the artifact.
 *
 * @module @deepseek-ai/dsh-model-capabilities/snapshot
 */

/** Schema version of the bundled document. Reading a different one fails loud. */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** One model of one models.dev provider entry, reduced to its effort claim. */
export interface ModelsDevSnapshotModel {
  /** Model id the provider entry is keyed by. */
  readonly id: string
  /** `reasoning_options` reduced to the effort control and its published tokens. */
  readonly reasoning_options: readonly {
    readonly type: string
    readonly values: readonly string[]
  }[]
}

/** One models.dev provider entry, reduced to its identity, endpoint, and models. */
export interface ModelsDevSnapshotProvider {
  /** Provider id the database states, which provider-id matching compares. */
  readonly id: string
  /** Published API URL, which endpoint-host matching normalizes. */
  readonly api?: string
  /** Model id to the effort claim that provider entry publishes for it. */
  readonly models: Readonly<Record<string, ModelsDevSnapshotModel>>
}

/**
 * The models.dev catalog as the bundled document carries it: the database's own
 * provider map, each entry reduced. This is exactly what
 * `resolvePublicCapability` reads for a models.dev catalog, so the loader hands
 * it over unchanged.
 */
export type ModelsDevSnapshotCatalog = Readonly<Record<string, ModelsDevSnapshotProvider>>

/** One OpenRouter model entry, reduced to its id and its effort claim. */
export interface OpenRouterSnapshotModel {
  /** Model id as published, including any vendor prefix. */
  readonly id: string
  /** Published effort list and default, unknown tokens included. */
  readonly reasoning: {
    readonly supported_efforts: readonly string[]
    readonly default_effort?: string
  }
}

/**
 * The OpenRouter catalog as the bundled document carries it: the published
 * `data` list, each entry reduced. This is exactly what
 * `resolvePublicCapability` reads for an OpenRouter catalog.
 */
export interface OpenRouterSnapshotCatalog {
  /** Models the capture published, reduced. */
  readonly data: readonly OpenRouterSnapshotModel[]
}

/** Where one source came from, so a reader can tell whether it moved. */
export interface SnapshotSourceMetadata {
  /** Repository-relative path of the document the snapshot was built from. */
  readonly input: string
  /** SHA-256 of that document's bytes, which the freshness gate recomputes. */
  readonly digest: string
  /** Provider or model entries this snapshot kept from that document. */
  readonly entryCount: number
}

/** The bundled document: what was captured, when, and the catalogs themselves. */
export interface ModelCapabilitySnapshot {
  /** Format version; a reader that does not know this one refuses the document. */
  readonly schemaVersion: number
  /** When `--write` produced this document, in ISO 8601 UTC. */
  readonly generatedAt: string
  /**
   * Per-database capture identity, keyed by the database's own name.
   *
   * The keys are the published database names, so a source list read by a
   * person and a key read by code agree.
   */
  readonly sources: {
    readonly 'models.dev': SnapshotSourceMetadata
    readonly openrouter: SnapshotSourceMetadata
  }
  /**
   * The two catalogs, in the document form the resolver reads.
   *
   * These keys are identifiers rather than published database names, so a
   * generated data module can spell them without quoting.
   */
  readonly catalogs: {
    readonly modelsDev: ModelsDevSnapshotCatalog
    readonly openRouter: OpenRouterSnapshotCatalog
  }
}

/** One curation pass's result: the kept catalog and how much was skipped. */
export interface CuratedCatalog<Catalog> {
  /** The catalog to publish, in deterministic entry order. */
  readonly catalog: Catalog
  /** Provider or model entries whose published form stated nothing usable. */
  readonly skipped: number
}

/** Both captures and the identity of the files they were read from. */
export interface SnapshotInputs {
  /** Repository-relative path the models.dev document was read from. */
  readonly modelsDevInput: string
  /** Parsed models.dev document, as captured or as curated. */
  readonly modelsDevSource: unknown
  /** SHA-256 of that document's bytes. */
  readonly modelsDevDigest: string
  /** Repository-relative path the OpenRouter document was read from. */
  readonly openRouterInput: string
  /** Parsed OpenRouter document, as captured or as curated. */
  readonly openRouterSource: unknown
  /** SHA-256 of that document's bytes. */
  readonly openRouterDigest: string
}

/** One built snapshot: the document plus the counts a caller reports. */
export interface BuiltSnapshot {
  /** The document to write. */
  readonly snapshot: ModelCapabilitySnapshot
  /** Curated models.dev provider entries. */
  readonly providerCount: number
  /** Curated OpenRouter model entries. */
  readonly modelCount: number
  /** Entries both curations skipped as stating nothing usable. */
  readonly skipped: number
}

/** Whether one parsed JSON value is a non-null object rather than an array or scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A published token list reduced to its non-empty strings, in published order.
 * @param values - the published list.
 * @returns the tokens, exactly as published and never translated.
 */
function effortTokens(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Rebuild one record in ascending key order, so identical captures yield
 * identical bytes whatever order the source stated its entries in.
 * @param record - the record to order.
 * @returns the same entries, key sorted.
 */
function sortRecord<Value>(record: Readonly<Record<string, Value>>): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * Read the `type: 'effort'` control one models.dev model states.
 *
 * Two forms reach this reader. The raw capture states `reasoning_options` as a
 * list of control descriptors, of which the effort one carries `values`; the
 * curated input keeps the tokens alone. Reading both means re-curating from a
 * fresh capture is the same derivation as generating from the committed input,
 * so the artifact stays reproducible from either.
 * @param model - one model entry, as captured or as curated.
 * @returns the effort tokens, or undefined when the entry states no effort control.
 */
function modelsDevEffortValues(model: unknown): string[] | undefined {
  const options = isRecord(model) ? model.reasoning_options : model
  if (!Array.isArray(options)) return undefined
  if (options.every(value => typeof value === 'string')) return effortTokens(options)
  for (const option of options) {
    if (!isRecord(option) || option.type !== 'effort') continue
    const values: unknown = option.values
    if (Array.isArray(values)) return effortTokens(values)
  }
  return undefined
}

/**
 * The provider entries one models.dev document states, whichever form it is in.
 *
 * The raw capture keys providers by their id; the curated input says so
 * explicitly under `providers`. Both carry `api` and `models` per provider, so
 * one reader accepts either.
 * @param database - the parsed document, in either form.
 * @returns provider id to entry, or nothing when the document is not a database.
 */
function modelsDevProviders(database: unknown): Record<string, unknown> {
  if (!isRecord(database)) return {}
  if (isRecord(database.providers)) return database.providers
  return database
}

/**
 * The model entries one models.dev provider states, whichever form it is in.
 * @param provider - the parsed provider entry.
 * @returns model id to entry, or nothing when the provider states no model map.
 */
function modelsDevModels(provider: Record<string, unknown>): Record<string, unknown> {
  return isRecord(provider.models) ? provider.models : {}
}

/**
 * One OpenRouter entry as either capture form states it.
 *
 * `id` is the entry's own id when it states one and nothing when it does not,
 * which is what makes an unusable id countable rather than silently dropped.
 */
interface OpenRouterEntry {
  /** Model id the entry states, or undefined when it is absent or not a usable string. */
  readonly id: string | undefined
  /** The entry itself, or the reasoning metadata alone in the curated form. */
  readonly value: unknown
}

/**
 * The model entries one OpenRouter document states, whichever form it is in.
 *
 * The raw capture lists models as an array of objects carrying `id`; the curated
 * input keys them by id and states the reasoning metadata alone. Both forms
 * reach {@link curateOpenRouterCatalog} the same way, and an entry that states
 * no usable id is reported rather than dropped.
 * @param database - the parsed document, in either form.
 * @returns one record per entry, in the order the document states them.
 */
function openRouterModels(database: unknown): OpenRouterEntry[] {
  if (!isRecord(database)) return []
  const data: unknown = database.data
  if (Array.isArray(data)) {
    const listed: readonly unknown[] = data
    return listed.map((model) => {
      const stated: unknown = isRecord(model) ? model.id : undefined
      const id = typeof stated === 'string' && stated.length > 0 ? stated : undefined
      return { id, value: model }
    })
  }
  return isRecord(data) ? Object.entries(data).map(([id, value]) => ({ id, value })) : []
}

/**
 * Read one OpenRouter entry's reasoning metadata, whichever form it is in.
 *
 * A captured entry is a model object carrying `reasoning`; a curated entry is
 * that reasoning object alone, so an entry without the key IS the metadata.
 * @param value - the entry as captured or as curated.
 * @returns the reasoning object, or undefined when the entry is not an object.
 */
function openRouterReasoning(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const reasoning = value.reasoning
  return isRecord(reasoning) ? reasoning : value
}

/**
 * Reduce one captured models.dev database to the claims this layer resolves.
 *
 * A provider entry that is not an object, one whose `models` is not an object,
 * and a model entry stating no effort control are each skipped and counted: the
 * snapshot keeps what a capture can be read for and records nothing it could
 * only guess at. A provider entry states its own `id` when the document does;
 * otherwise the key it is filed under is its identity. An effort control whose
 * tokens are all unusable is kept with the empty list it published, which the
 * resolver already reads as a model that offers no level.
 * @param database - the parsed `models.dev/api.json` document, or its curated form.
 * @returns the curated catalog document and how many entries were skipped.
 */
export function curateModelsDevCatalog(database: unknown): CuratedCatalog<ModelsDevSnapshotCatalog> {
  const entries: Record<string, ModelsDevSnapshotProvider> = {}
  let skipped = 0
  for (const [filedAs, provider] of Object.entries(modelsDevProviders(database))) {
    if (!isRecord(provider)) {
      skipped += 1
      continue
    }
    const id = typeof provider.id === 'string' && provider.id.length > 0 ? provider.id : filedAs
    const models: Record<string, ModelsDevSnapshotModel> = {}
    for (const [modelId, model] of Object.entries(modelsDevModels(provider))) {
      const values = modelsDevEffortValues(model)
      if (values === undefined) {
        skipped += 1
        continue
      }
      models[modelId] = { id: modelId, reasoning_options: [{ type: 'effort', values }] }
    }
    if (Object.keys(models).length === 0) {
      skipped += 1
      continue
    }
    entries[id] = {
      id,
      ...typeof provider.api === 'string' && provider.api.length > 0 ? { api: provider.api } : {},
      models: sortRecord(models),
    }
  }
  return { catalog: sortRecord(entries), skipped }
}

/**
 * Reduce one captured OpenRouter database to the claims this layer resolves.
 *
 * An entry that is not an object, one without an exact id, and one whose
 * reasoning metadata is not the published form are each skipped and counted. A
 * model is kept when it publishes a support list, even an empty one: that a
 * model supports no offered level is a statement the resolver already reads,
 * and dropping it here would hide that the database said so.
 * @param database - the parsed `/api/v1/models` document, or its curated form.
 * @returns the curated catalog document and how many entries were skipped.
 */
export function curateOpenRouterCatalog(database: unknown): CuratedCatalog<OpenRouterSnapshotCatalog> {
  const models: Record<string, OpenRouterSnapshotModel> = {}
  let skipped = 0
  for (const entry of openRouterModels(database)) {
    const reasoning = openRouterReasoning(entry.value)
    const curated = entry.id === undefined || reasoning === undefined
      ? undefined
      : curateOpenRouterReasoning(entry.id, reasoning)
    if (curated === undefined) skipped += 1
    else models[curated.id] = curated
  }
  return { catalog: { data: Object.values(sortRecord(models)) }, skipped }
}

/**
 * Reduce one OpenRouter model's reasoning metadata to the claim this layer resolves.
 * @param modelId - the model id the entry is keyed by.
 * @param reasoning - the published reasoning object, or its curated form.
 * @returns the curated entry, or undefined when the metadata states no support list.
 */
function curateOpenRouterReasoning(
  modelId: string,
  reasoning: Record<string, unknown>,
): OpenRouterSnapshotModel | undefined {
  const published = reasoning.supported_efforts
  if (!Array.isArray(published)) return undefined
  const defaultEffort = reasoning.default_effort
  return {
    id: modelId,
    reasoning: {
      supported_efforts: effortTokens(published),
      ...typeof defaultEffort === 'string' && defaultEffort.length > 0 ? { default_effort: defaultEffort } : {},
    },
  }
}

/**
 * Assemble the bundled document from both curated captures.
 *
 * Ordered catalogs are the determinism mechanism: the same captures produce the
 * same bytes, and only `generatedAt` differs between two writes.
 * @param inputs - both captures and the identity of the files they were read from.
 * @param generatedAt - the timestamp to record, in ISO 8601 UTC.
 * @returns the document and the entry counts it covers.
 */
export function buildSnapshot(inputs: SnapshotInputs, generatedAt: string): BuiltSnapshot {
  const modelsDev = curateModelsDevCatalog(inputs.modelsDevSource)
  const openRouter = curateOpenRouterCatalog(inputs.openRouterSource)
  const providerCount = Object.keys(modelsDev.catalog).length
  const modelCount = openRouter.catalog.data.length
  return {
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt,
      sources: {
        'models.dev': {
          input: inputs.modelsDevInput,
          digest: inputs.modelsDevDigest,
          entryCount: providerCount,
        },
        openrouter: {
          input: inputs.openRouterInput,
          digest: inputs.openRouterDigest,
          entryCount: modelCount,
        },
      },
      catalogs: { modelsDev: modelsDev.catalog, openRouter: openRouter.catalog },
    },
    providerCount,
    modelCount,
    skipped: modelsDev.skipped + openRouter.skipped,
  }
}

/**
 * Whether one value is a source metadata block a freshness check can compare.
 * @param value - the parsed `sources.<database>` value.
 * @returns whether it carries an input path, a digest, and an entry count.
 */
function isSnapshotSource(value: unknown): boolean {
  return isRecord(value)
    && typeof value.input === 'string' && value.input.length > 0
    && typeof value.digest === 'string' && value.digest.length > 0
    && typeof value.entryCount === 'number'
}

/**
 * Whether one value is the catalog this layer's readers accept for a database.
 *
 * A models.dev catalog is its provider map; an OpenRouter catalog is its `data`
 * list. An empty map or list is refused rather than accepted as an empty
 * database, because a snapshot with nothing to resolve is a failed generation,
 * not a deployment with no public metadata.
 * @param source - the database the catalog belongs to.
 * @param value - the parsed catalog for that database.
 * @returns whether it states at least one entry in that database's own shape.
 */
function isSnapshotCatalog(source: 'models.dev' | 'openrouter', value: unknown): boolean {
  if (!isRecord(value)) return false
  return source === 'openrouter'
    ? Array.isArray(value.data) && value.data.length > 0
    : Object.keys(value).length > 0
}

/**
 * Read one bundled document, refusing anything this build cannot resolve.
 *
 * The checks are structural rather than per-model: a document whose version,
 * catalog, or source metadata is wrong was not produced by this package's
 * generator, and guessing at it would publish claims nobody captured. The
 * resolver still validates each entry it reads, so a bad entry inside a valid
 * document states nothing rather than failing the lookup.
 * @param value - the parsed bundled document.
 * @returns the validated document.
 * @throws When the value is not a snapshot this build can read.
 */
export function parseSnapshot(value: unknown): ModelCapabilitySnapshot {
  const snapshot = isRecord(value) ? value : undefined
  if (snapshot === undefined || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `bundled capability snapshot schema version ${JSON.stringify(snapshot?.schemaVersion ?? null)} `
      + `is not ${SNAPSHOT_SCHEMA_VERSION}; run \`pnpm run gen-model-capability-snapshot\``,
    )
  }
  if (typeof snapshot.generatedAt !== 'string' || snapshot.generatedAt.length === 0) {
    throw new Error('bundled capability snapshot states no generatedAt timestamp')
  }
  const sources = isRecord(snapshot.sources) ? snapshot.sources : {}
  const catalogs = isRecord(snapshot.catalogs) ? snapshot.catalogs : {}
  const stated: readonly [keyof ModelCapabilitySnapshot['catalogs'], 'models.dev' | 'openrouter'][] = [
    ['modelsDev', 'models.dev'],
    ['openRouter', 'openrouter'],
  ]
  for (const [field, source] of stated) {
    if (!isSnapshotSource(sources[source]) || !isSnapshotCatalog(source, catalogs[field])) {
      throw new Error(`bundled capability snapshot states no usable "${source}" catalog and source metadata`)
    }
  }
  return snapshot as unknown as ModelCapabilitySnapshot
}
