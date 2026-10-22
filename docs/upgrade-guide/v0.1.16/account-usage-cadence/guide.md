---
kind: upgrade-guide
description: "Active-account usage caching becomes adaptive instead of using one fixed minimum interval."
---

# Adaptive account usage refresh

English | [中文](guide.zh.md)

## Change

The `settings-controller` entry caches active-account usage for 60 seconds by default, shortening to 30, 15, and 5 seconds at 75%, 90%, and 99% used. Previously it used a fixed 30-second minimum. `activeAccountUsageRefreshMs` now supplies the base interval, which `accountUsageRefreshTiers` can shorten. Failed active reads normally retry after five seconds, and automatic HTTP 429 reads honor a bounded Retry-After cooldown. Inactive-account caching remains five minutes.

Browser account responses may include optional `usageRefreshIntervalMs` scheduling metadata. Saved account records and credentials require no migration.

## Migration

1. Keep the defaults to use adaptive refresh. If a profile requires the previous fixed active-account interval, edit its `settings-controller` entry in `cordis.patch.yml`:

   ```yaml
   - id: settings-controller
     config:
       activeAccountUsageRefreshMs: 30000
       accountUsageRefreshTiers: []
       failedAccountUsageRefreshMs: 30000
       accountUsageMaxRetryAfterMs: 30000
   ```

2. Substitute your previous custom interval for `30000` where applicable. An explicit `activeAccountUsageRefreshMs: 0` still disables success caching. Explicit fresh refreshes bypass the usage cache and cooldown.
3. Reload the profile and confirm that automatic quota updates follow the selected interval while its window is visible. Model requests continue using committed account state without waiting for usage reads.
