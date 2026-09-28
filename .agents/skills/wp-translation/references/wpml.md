# WPML

## Relationships and editing ownership

Inspect the source/target translation group, element type, language, and source language before creating or linking anything. Use supported WPML operations; translated-looking content is not necessarily linked. Terms may have provider-specific identifiers different from post IDs or ordinary term IDs; use the actual endpoint contract rather than guessing.

Determine whether content is managed by WPML's translation editor/jobs, duplication/synchronization, or independent manual editing. An edit to synchronized translated content may be overwritten. Do not detach duplication, cancel jobs, delete translation-management records, or switch editing mode without the user's informed choice for that content. Preserve unrelated translations in the group.

Translate/map required taxonomies first, then posts/CPTs/products. Re-read relationships after creation. Use dry-run relationship repair where available and confirm both objects really represent the same source item before linking.

## Menus and strings

For ordinary WPML-managed navigation, prefer WPML Menu Sync where supported. Translate labels, URLs, and language-specific page references; retain source/target relationships. Independently maintained menus are a deliberate site choice, not a universal fallback. Verify menu locations and builder widgets referencing explicit menu IDs.

Search registered strings by source text plus domain/context/name. Inspect duplicate rows and the effective rendered owner before updating. Changing an inactive duplicate is not a successful translation. Gateway/theme settings may require the corresponding registered option string rather than content replacement. Re-read the effective translation and check the rendered language.

## Tool use

Use existing relationship and effective-string diagnostics if available. Discover API routes and metadata before calling unfamiliar operations. Fetch compact summaries before full content. A tool with a dry-run default needs an explicit reviewed write step; a successful dry-run alone does not mean anything was saved.

WooCommerce and page builders require their own integration guidance. Do not copy this provider's `trid`, string-table, or menu-sync procedures into Polylang or another provider.
