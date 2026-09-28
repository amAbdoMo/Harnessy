# Retrieve and maintain local knowledge

## Runtime and storage

Use `load_workspace_dependencies` when available and invoke its Python executable with this skill's `scripts/memory.py` absolute path. Otherwise use an already available Python 3.9+ interpreter with SQLite JSON support (JSON1 on older SQLite builds); do not install one silently. The helper probes JSON support and reports a missing capability rather than returning empty results. Resolve paths from the skill resource directory, not the session working directory. The helper uses only the standard library and never contacts WordPress.

The default store is `~/.agents/knowledge/wp-translation/knowledge.sqlite3`, shared across local sessions/agents using the same OS account. An absolute `WP_TRANSLATION_MEMORY_HOME` selects a different directory; `--store <absolute-file>` overrides it for one invocation. Use the same store consistently across sessions. It is local reference data, not encrypted credential storage, a cloud sync service, or an access-control boundary between agents. Do not put customer data or secrets in it.

Run `status` first to discover the resolved path. Reads do not create a missing store. The first valid save attempt initializes the schema before its lesson transaction; a later failed lesson write may leave a valid empty store. An interrupted or failed schema initialization is reported as a malformed store rather than silently reset. For tests and offline demonstrations, always use an isolated explicit `--store` under the task's temporary directory. Never seed fictitious lessons into the real default store.

## Commands

In these examples `python` means the selected interpreter and `memory.py` means the absolute script path. Options `--store` precede the command.

```text
python memory.py status
python memory.py search --site https://example.test/store --provider wpml --tags menus --language ar
python memory.py get example-store-wpml-menus
python memory.py save --input lesson.json --expected-revision 0
python memory.py history example-store-wpml-menus --limit 8
python memory.py get example-store-wpml-menus --revision 1
python memory.py retire example-store-wpml-menus --expected-revision 2 --reason "Replaced by verified site configuration"
```

Search returns short summaries, IDs, revisions, and `more`; read selected records with `get`. Site-specific matches precede global matches. Provider must match or be `any`; language-specific records require the requested language. With no language, only language-neutral records match. Tags use any-match, and query uses a case-insensitive substring (SQLite's built-in case conversion primarily covers ASCII). With no tags/query, retrieve applicable records without those filters. Narrow the query if `more` is true; do not assume the first page is complete. Use a short task-specific query or tags so a broad search does not hide a relevant rule behind other matches.

Use `--include-candidates` only to investigate unresolved lessons, not to activate them. `get`, `history`, and `export` are explicit local administrative reads, not site-isolated authorization operations; validate a retrieved record's scope before applying it. Search omits retired records.

`save` requires a UTF-8 JSON object:

```json
{
  "id": "example-store-wpml-menus",
  "kind": "preference",
  "scope": "site",
  "site": "https://example.test/store",
  "provider": "wpml",
  "language": null,
  "tags": ["menus"],
  "title": "Use linked menu synchronization",
  "text": "For this site, use WPML Menu Sync for normal translated navigation rather than unrelated independent menus.",
  "evidence": [{"type": "user", "reference": "Current task correction", "note": "The user explicitly chose this site's menu workflow."}],
  "status": "active"
}
```

This is a fictitious format example, not a lesson to install. Read [learning](learning.md) before writing real records. For a new ID use expected revision `0`; for an update use the revision just read. Do not send the `get` wrapper: save its `record` object after justified changes. Global scope requires `site: null` and `--allow-global`, with explicit human intent for cross-site reuse. New technical procedures/site profiles need declared verification evidence before active status; the helper checks evidence categories, not truth.

## History, recovery, and failure

Every save and retirement appends a revision. To restore an earlier rule, fetch that revision, reconcile its contents with the current task, and save its record using the current head's expected revision. Historical rows stay intact. SQLite transactions prevent two writers from overwriting the same expected revision; after a conflict, re-read and reconcile rather than overwrite blindly.

`export --output <new-absolute-file.jsonl>` writes all revisions for local backup and refuses to overwrite an existing file. Exports may contain private site notes; review before sharing. There is no automatic import, synchronization, encryption, retention policy, or hard-delete command. For recovery, retain the database as the authoritative local backup; the JSONL export is inspectable history, not a one-command restore format. Back up a closed database or use SQLite's supported backup facility rather than copy an actively written database blindly.

A missing store returns empty search/history and a nonexisting status. Invalid input, revision conflict, detected structural corruption/unsupported schema, or I/O failure returns nonzero with an error; never silently reset the database. Opening checks SQLite integrity, required columns/keys, and head/revision links; complete field validation applies to records actually retrieved, not an exhaustive semantic audit of all history. Search/history limits are 1–30, default 8. Text and metadata are bounded and normal JSON output is capped at 65,536 bytes. Export streams to the chosen file rather than dumping history into model context.
