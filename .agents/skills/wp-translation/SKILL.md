---
name: wp-translation
description: "Translate, audit, or repair multilingual WordPress content with WPML, Polylang, or another provider, including WooCommerce, CPTs, taxonomies, ACF, Elementor, menus, and strings. Use for WordPress translation work and corrections to it, even when no translation plugin is named. Retrieves scoped lessons and saves explicit preferences or verified procedures for reuse. Not for general prose translation or unrelated WordPress development."
---

# WordPress translation

Use existing WordPress/MCP capabilities. This skill supplies procedures and persistent knowledge, not WordPress access or permission to change a site. Follow current user instructions and applicable safety skills ahead of stored lessons.

## Start with the smallest context

1. Identify the exact site (including a WordPress subdirectory), requested languages, task, and allowed changes. Discover the active translation provider, relevant integrations, versions, content types, and available read/write tools. Do not infer provider or language from tool names alone.
2. Read [knowledge](references/knowledge.md) to retrieve applicable saved lessons. Use the bundled interpreter when available. Search by site, provider, task tags, and language; fetch only relevant records. An unavailable store is a visible limitation, not a reason to stop otherwise safe work.
3. Load only the relevant modules below. Refresh saved site facts against live configuration before using identifiers or compatibility-sensitive procedures. Do not replay old conversations or load the whole library.

| Task | Read |
|---|---|
| Every site mutation | [Discovery and verification](references/core.md) |
| WPML relationships, jobs, menus, strings | [WPML](references/wpml.md) |
| Polylang content, terms, menus, strings | [Polylang](references/polylang.md) |
| Products, variations, checkout, account | [WooCommerce](references/woocommerce.md) |
| Custom types, taxonomies, ACF, metadata | [Structured content](references/structured-content.md) |
| Elementor, templates, theme-owned text, RTL | [Builders and themes](references/builders.md) |
| A correction, successful repair, or glossary choice | [Learning](references/learning.md) |

For an unsupported provider, use discovery and structured-content guidance, then inspect its documented API and actual tool support. WPML and Polylang procedures are not interchangeable.

## Execute and learn

- Find the source of each visible string before editing. Audit relationships and dependencies; translate required terms before dependent content. Show a compact scope/dry-run for bulk changes.
- Preserve functional identifiers and business data. Prefer supported settings, translation editors, and provider APIs; do not introduce a plugin, snippet, direct database write, or CSS workaround just to make text look translated.
- Apply a small representative batch, validate saved relationships and frontend behavior, then continue. Retrying must not create duplicate translations.
- When the user corrects the work, apply the correction now and follow the learning procedure before finishing. Save only its justified scope; do not turn a one-site exception into a global rule. Keep unverified technical ideas as candidates.
- Give delegated agents the site, allowed changes, applicable rules/revisions, and verification requirements. They return proposed lessons; the parent consolidates writes to avoid duplicates and conflicting updates.

## Completion

Report translated/repaired scope, checks actually performed, remaining issues, and any saved lesson IDs and scope. Distinguish frontend scans from browser checks and data integrity from functional verification. If persistence failed, say the correction is applied only to this session. Never claim the skill learns autonomously, guarantees compliance, or has retrained the model.
