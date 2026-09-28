# WooCommerce translation

## Catalog

Confirm the translation provider's commerce integration is active and compatible. Audit missing translations, existing relationships, product types, variations, attributes, taxonomy mappings, and status differences before changing products. SKU matching alone is not a reliable translation-linking strategy.

Preserve SKU, prices, sale dates, stock, tax/shipping settings, dimensions, downloadable-file permissions, subscriptions/bookings configuration, and integration-owned metadata. Do not normalize synchronized business data by writing each translation independently. Let the supported commerce integration own synchronization; investigate mismatches before repair.

Translate product names, descriptions, relevant taxonomy labels, attribute terms, and customer-visible options through their actual owners. Preserve canonical attribute keys, option IDs, variation links, pricing keys, and add-on identifiers. Do not assume every attribute is a taxonomy or every visible label is stored on the product.

For variable products, map translated attribute terms and preserve parent/variation relationships. Check defaults, available combinations, image choices, stock behavior, price display, and add-to-cart from the target language. A translated parent title is not a completed variable-product translation.

## Shop, cart, checkout, account

Inspect configured system-page IDs and their provider-linked translations. Keep supported WooCommerce blocks or shortcodes; never replace page content with a rendered cart/checkout form. Diagnose labels at their source: WooCommerce, block settings, field editor, gateway, shipping method, theme, or registered string.

Verify checkout with a nonempty test cart and the relevant locale/session, since an empty checkout may redirect. Classic checkout hooks and block checkout extensions differ; use the active implementation's documented mechanism. Do not add filters/snippets solely because a string search returned nothing.

Test localized product links, cart actions, validation text, shipping/payment labels, and account navigation as applicable. Do not initiate payments, submit orders, change customer/order data, or send transactional email without separate authorization. Do not save cart tokens, customer details, order records, or credentials in the lesson store.
