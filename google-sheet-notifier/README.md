# Google Sheet email notifications

`Code.gs` runs on Google's servers and checks a spreadsheet every minute.
When its contents change, it emails you a link. Your computer can be off; no
email password, API key, or local scheduler is needed. It is ready to configure,
but no monitor is installed merely by downloading these files.

## Setup

1. Sign in to the Google account that can read the spreadsheet, open
   [Google Apps Script](https://script.google.com/), and create a **New project**.
   A standalone project also lets you monitor a sheet you can view but cannot edit,
   provided your organization's policies allow Apps Script access.
2. Replace the default `Code.gs` contents with this folder's `Code.gs`.
3. Edit `CONFIG` at the top:

   ```javascript
   const CONFIG = {
     SPREADSHEET_ID: 'your_spreadsheet_id',
     RECIPIENT_EMAIL: 'your-address@gmail.com',
     SHEET_ID: null,
     CHECK_EVERY_MINUTES: 1,
   };
   ```

   For a URL like `https://docs.google.com/spreadsheets/d/ABC123/edit#gid=456`,
   use `SPREADSHEET_ID: 'ABC123'`, or paste the entire URL inside the quotes.
   Surrounding whitespace is ignored. To watch only that tab/page, use
   `SHEET_ID: 456` (a number, without quotes). Keep `null` to watch all tabs.
   The tab ID stays the same if the tab is renamed; `0` is a valid tab ID.
   The URL's `gid` does not automatically select a tab: `SHEET_ID` controls that.
4. Save, choose **installMonitor** from the function dropdown, and click **Run**.
   Authorize access to spreadsheets, sending email, and managing this project's
   triggers. Installation saves the current state without sending an email.
   There is no web-app deployment step.
5. Choose **sendTestEmail** and click **Run** to verify delivery. Then make a
   change to the sheet and wait for the next check, or run **checkForUpdates**
   manually to check immediately.

Email is sent from the account that runs the script to `RECIPIENT_EMAIL`. The
message includes the spreadsheet title, monitored scope, detection time in UTC,
and sheet link. Cell contents are not included in the email or stored in the
monitor's saved state.

## Controls

- **checkForUpdates**: check immediately using the saved baseline.
- **sendTestEmail**: send one test message; does not change the baseline or start monitoring.
- **installMonitor**: install or replace this account's timer and reset the baseline.
  Run again after changing the spreadsheet, tab, or interval. Reinstalling starts
  from the current contents, so it does not report changes pending before reinstall.
- **uninstallMonitor**: stop the timer and clear its baseline. Other project
  triggers and settings are left alone.

Use a separate Apps Script project for each spreadsheet you want to monitor.
The interval may be `1`, `5`, `10`, `15`, or `30` minutes. These are Google's
[supported timer intervals](https://developers.google.com/apps-script/reference/script/clock-trigger-builder#everyMinutes(Integer)).

## What counts as an update

The script compares values (including calculated formula results), formula text,
tab names, grid row/column counts, and the spreadsheet title. When watching all
tabs it also detects tabs being added, removed, or reordered. When watching a
single tab it ignores other tabs' content and detects deletion of the watched tab.
Renaming the spreadsheet sends a notification in either mode.

It catches changes made by people, forms, APIs, and other scripts when those
changes are visible at the next check. A timer is used because edit triggers
[do not fire for script/API edits](https://developers.google.com/apps-script/guides/triggers/installable#restrictions).

This is polling, so notifications are not instantaneous and are not an audit log
of every edit. Several edits between checks produce one email; a change reverted
before the next check can be missed. Formatting, comments, notes, sharing changes,
charts, and other metadata are not monitored. Volatile formulas such as `NOW()`
or `RAND()` can cause frequent notifications when their values recalculate.

Google's [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
apply to emails and execution time. Large or frequently changing spreadsheets
may need a longer interval or monitoring of just one tab. If sending fails or
the mail quota is exhausted, the baseline is retained and a later check retries
if the sheet still differs. This does not retain a queue of intermediate changes.
If email succeeds but saving the baseline fails, a later check can send a duplicate.

Check the Apps Script **Executions** page for failures, including loss of access
or a deleted spreadsheet. Such read failures never replace the baseline with
empty data. Google also provides trigger failure notifications as described in
its [trigger guide](https://developers.google.com/apps-script/guides/triggers/installable#errors_in_triggers).

## Troubleshooting "Illegal argument: id"

`SPREADSHEET_ID` identifies the entire file: it is the long string between `/d/`
and `/edit` in its URL. `SHEET_ID` identifies one tab: it is the numeric `gid`.
Keep the spreadsheet ID or full URL in quotes and the tab ID as a number.
The script now accepts full URLs and trims surrounding spaces before calling
Google's [openById](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app#openById(String)).

After correcting the settings, save and run **installMonitor** again. If the
error persists, check the exact failing line in **Executions** and confirm the
Google account running the script can open that spreadsheet. ID parsing alone
cannot verify access to the file.

## Local checks

Run `node --test google-sheet-notifier/test.cjs` from the repository root. The
tests use mocked Google services and do not access a real spreadsheet or send
email. Live authorization, scheduling, and delivery must be checked in Apps Script.
