# Polylang

## Discover support

Confirm Polylang edition, version, registered languages, enabled post types/taxonomies, and available integration/API capabilities. Confirm the site's WooCommerce integration separately; ordinary Polylang post translation does not establish safe product or variation synchronization. If required commerce support is absent, stop product mutations and explain the dependency.

Do not invoke WPML translation-group, translation-editor, or String Translation operations on Polylang. Do not infer a writable REST API merely because Polylang is installed. Use supported admin flows or exposed documented tools; missing access is not a reason to create an ad hoc PHP endpoint.

## Content relationships

Inspect the object's language and complete translation mapping. Supported integrations may expose equivalents of `pll_get_post_translations`, `pll_get_term_translations`, language setters, and translation-map savers; availability and authorization must be established before use. Preserve existing sibling-language entries when updating a mapping. Replacing a translation map with only two languages can sever other relationships.

Translate terms first and assign target-language terms to translated posts/CPTs. Check parent/child relationships, translated internal links, featured media policy, and configured synchronized custom fields. Preserve values that are intentionally synchronized; do not assume all metadata should be copied or translated.

## Menus, strings, and checks

Inspect language-specific menu assignments and switcher configuration through Polylang's supported mechanisms. Do not assume WPML Menu Sync exists. Keep menu IDs and location assignments appropriate to the target language.

Find whether a string belongs to registered Polylang strings, gettext/plugin language files, content, or an integration option. Use that owner's translation mechanism; never search-and-replace all options or invent a string registration capability.

Verify source and target URLs, language mappings, translated terms, language switching, and frontend output. For commerce, apply the WooCommerce module and integration-specific documentation before edits.
