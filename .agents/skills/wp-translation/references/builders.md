# Builders, themes, and RTL

Identify page, header/footer, archive, single-content, popup, loop, and nested-template ownership. A translated page may still include a source-language template or theme option. Inspect compact document summaries and relationships before loading large builder JSON.

For Elementor, preserve widget/container IDs, repeater item IDs, selectors, dynamic-tag data, and integration-sensitive structure. Prefer supported translation/editor operations and minimal targeted text/link changes. Direct raw-data changes require demonstrated tool support, valid serialization, before-state capture, and verification; do not rebuild a document from rendered HTML.

Source-document reconstruction is a repair strategy only when corruption is established and target-only changes are accounted for. Do not overwrite intentional translated layouts merely because their structures differ. Determine translation-editor/duplication ownership before changing metadata.

Verify nested template references, target-language links, generated CSS, editor selection/interactivity, and frontend rendering. A valid JSON document can still have an unusable editor; diagnose overlays, duplicate inclusions, or stale generated assets before replacing content. Do not add generic CSS hiding rules to mask an editor problem.

For RTL/LTR, check direction, alignment, icon order, spacing, navigation, forms, and responsive layout rather than flipping every CSS property. Retain brand/numeric conventions intentionally shared across languages.

For Woodmart or other themes, determine whether text/styles belong to a global option, a language-specific option, an assigned layout, or a conditional preset. Inspect actual preset selection and generated CSS when values do not appear. Never change a global option to solve one-language presentation without explicit scope approval. Verify both languages after shared-setting changes.
