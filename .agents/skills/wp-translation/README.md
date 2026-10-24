# WordPress translation skill

## Summary

Use the existing WordPress MCP connection with a small translation workflow, provider-specific guidance, and a local revisioned lesson store. The agent retrieves relevant preferences, terminology, and verified procedures instead of replaying previous conversations. Learning is agent-directed: it must run and verify a save; no background service reads conversations or rewrites instructions.

## Contents

- [Activation](#activation)
- [Using corrections](#using-corrections)
- [Storage and privacy](#storage-and-privacy)
- [Verification](#verification)
- [Limits](#limits)

## Activation

The maintained source is `.agents/skills/wp-translation` in the canonical Harnessy staging repository. The shared installation is the complete bundle under the configured shared skills folder, normally `~/.agents/skills/wp-translation`. Project and shared copies use the same external lesson store unless explicitly configured otherwise. Project skills can override a same-name shared skill, so both bundles must carry the same reviewed instructions and helper files.

For a skill update, compare both bundles first and reconcile any independent edits into the repository source. Preserve a recoverable copy before replacing differing installed files. After validation, synchronize the complete reviewed bundle into the shared directory and compare relative file lists and contents, excluding generated Python caches. Do not copy the external lesson database into either bundle or overwrite unrelated skills. Confirm the resource directory in the target session; filesystem discovery does not guarantee that an existing conversation has refreshed. This is an update procedure, not a background synchronization service.

Load `wp-translation` explicitly for the first task and check the returned resource directory. No application build or WordPress plugin installation is required. Remote machines need their own installed bundle and authorized connection.

Other agents can load the same portable directory if they support instruction skills and Python execution. They need separate authorized WordPress access. The skill does not bundle an MCP server or assume one site's credentials.

## Using corrections

Ask for a normal translation task, or explicitly say “Use wp-translation.” State the site and languages. When correcting the result, say whether the preference is for this site or all your sites. The agent searches for matching knowledge, updates a stable record with an expected revision, and confirms the saved record. Meaningful confirmed changes receive the brain-icon **Memory updated:** blockquote defined in the [completion instructions](SKILL.md#completion); candidates are labeled unverified and unchanged memory produces no notice. Technical guesses remain candidates until verified. Technical lessons record actual verification dates and relevant observed plugin versions using the [learning format](references/learning.md#verification-details); missing historical details stay unknown until rechecked.

Examples:

- “For this site, use WPML Menu Sync rather than independent menus.”
- “For this site's Arabic labels, use المتجر for Shop.”
- “This is a one-time workaround; do not make it a general rule.”

[Learning rules](references/learning.md) define evidence, scope, conflict handling, and freshness. [Command reference](references/knowledge.md) defines retrieval, history, retirement, and restore-by-new-revision. Saved text is reference data, not authority to override current instructions or safety constraints.

## Storage and privacy

The default database is outside the skill and outside the project at `~/.agents/knowledge/wp-translation/knowledge.sqlite3`. This avoids losing lessons when a remote-site session receives a fresh working directory. An absolute `WP_TRANSLATION_MEMORY_HOME` or per-command `--store` selects another location. Use the same store across agents to share lessons deliberately.

Nothing synchronizes to another computer or uploads to a service automatically. The database is not encrypted, and site scoping is retrieval logic rather than OS-level access control. Store no credentials, customer/order data, or full transcripts. Review all-history exports before sharing. Skill updates do not automatically update or delete learned records.

## Verification

Run the local helper checks from the skill directory, replacing `python` with the bundled interpreter when available:

```text
python -B -m unittest discover -s tests -v
```

The tests use temporary SQLite databases, not the user's default store. The repository's `wp-translation-skill` recorded-session scenario loads the current instruction source through the shipped headless profile. [Offline evaluation prompts](evals/evals.json) exercise catalog translation, Polylang/CPT mapping, and scoped learning with an untrusted instruction. They do not establish live-site compatibility or measure long-term correction reduction.

## Limits

- Python 3.9+ with SQLite JSON support is required for persistence; prefer the bundled interpreter.
- Detection and execution depend on the agent following the skill. No deterministic hook guarantees every correction is captured.
- Evidence categories are validated; the helper cannot authenticate a user quotation or a claimed browser check.
- Candidate records are excluded from ordinary retrieval. Changed site configuration must be rechecked rather than trusted from memory.
- Search uses exact scope/provider/language filters, tags, and substring matching, not semantic embeddings. It returns bounded results; narrow searches when more matches exist.
- SQLite checks structural integrity when opening; record fields are validated when retrieved. This favors reliable local knowledge over a network service, but very large histories may need a different indexed storage design.

## Dev Note

None.
