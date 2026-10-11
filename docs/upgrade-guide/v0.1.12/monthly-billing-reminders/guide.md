---
kind: upgrade-guide
description: "Saved manual billing reminders now display monthly future occurrences instead of fixed dates with overdue labels."
---

# Monthly billing reminders

English | [中文](guide.zh.md)

## Change

The Accounts manager replaces the fixed manual billing date and overdue label with a reminder icon and the next monthly date. On the entered date's local calendar day, the display advances to the first occurrence strictly after today. Months without the original day use their last day, then restore the original day in longer months. The display catches up when the application reopens.

The protected `manualBillingDate` remains the original user-entered `YYYY-MM-DD` anchor; Remote reads and `accounts/changed` still return that anchor, not the computed future occurrence. Automatic rollover performs no credential-store writes or provider requests. Dates are reminders, not confirmed provider invoices. The account row displays `DD/MM/YYYY`; the popup edits the original anchor.

## Migration

1. Open Accounts and select the intended Personal or Workspace membership. Existing saved dates automatically become monthly anchors; no data rewrite is required.
2. Open the reminder icon to check or edit the original date. Clear it if the saved date was intended as a one-time reminder rather than a monthly schedule.
3. Confirm the row shows the next future occurrence. A date on day 17 advances from October to November 17; a day-31 anchor uses February's last day and returns to March 31. Beyond year 9999, the popup explains that no supported next date exists and allows editing or clearing.
