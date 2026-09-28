# CPTs, taxonomies, and custom fields

Discover each post type's slug, REST base, hierarchy, translation setting, relevant taxonomies, and template/builder ownership. Use the actual discovered type rather than hardcode services, projects, products, or language codes.

Classify fields before copying: translatable text, synchronized value, copy-once value, language-specific reference, computed/internal identifier, and intentionally untranslated value. Inspect provider and ACF/integration policies; labels alone cannot establish field behavior. Preserve field keys, repeater row structure, flexible-content layouts, and dynamic-tag syntax.

Map post-object, relationship, parent, taxonomy, menu, and template references to the corresponding target-language object when the site's configured policy requires it. Do not blindly translate URLs inside serialized data, JSON, HTML attributes, or code. Use structure-aware supported editors/APIs and preserve valid serialization.

Translate required terms and hierarchical parents before dependent entries. Preserve intended publication status, author, featured media policy, menu order, and template assignment. Check attached terms, translated parent chains, target object references, archive output, and a representative single-entry page.

Treat missing API exposure and unsupported provider/type combinations as explicit limitations. Do not create an unrelated standalone target entry as a substitute for a provider-linked translation without the user's decision.
