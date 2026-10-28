/**
 * Email notifications for multiple Google spreadsheets or selected tabs.
 *
 * SETUP
 * 1. Replace the old script in the SAME Apps Script project with this file.
 * 2. Add an entry to CONFIG.TARGETS for each spreadsheet/tab to monitor.
 *    NAME is your custom name, shown in notification subjects and messages.
 *    Leave NAME blank or omit it to use the actual spreadsheet title.
 *    SPREADSHEET_ID is the text between /d/ and /edit in its URL.
 *    SHEET_ID: null watches all tabs; a numeric gid (including 0) watches one.
 * 3. Save, then run installMonitor and authorize access when prompted.
 *    Installation resets ALL configured baselines without sending any email.
 * 4. Optional: run sendTestEmail to send one test email per target.
 *
 * Run installMonitor again after changing targets or the check interval.
 * Run installMonitor again after adding/removing targets, changing their
 * spreadsheet/tab IDs, or changing the check interval. Changing only NAME
 * takes effect on save; it does not need reinstalling or reset the baseline.
 * Run uninstallMonitor to stop. One timer checks every configured target.
 *
 * Detects values, formulas, spreadsheet/tab names, tab additions/deletions,
 * tab order (when watching all tabs), and row/column counts. Does not detect
 * formatting-only changes, comments, or edits reverted between checks.
 * Formula recalculations can also produce notifications.
 * Google Apps Script runtime and email quotas still apply.
 */
const CONFIG = {
  RECIPIENT_EMAIL: 'everettx@umich.edu',
  CHECK_EVERY_MINUTES: 1, // Allowed: 1, 5, 10, 15, 30.
  TARGETS: [
    {
      NAME: 'My first spreadsheet', // Choose the name shown in emails.
      SPREADSHEET_ID: '1ALxhGJj-22bBSxWLq-MJsUExU-udQI27s_qOSy57n8I',
      SHEET_ID: null, // All tabs in this spreadsheet.
    },
    // Add more entries by copying either example and removing its // marks:
    // {
    //   NAME: 'Budget tracker',
    //   SPREADSHEET_ID: 'PASTE_SECOND_SPREADSHEET_ID_HERE',
    //   SHEET_ID: null,
    // },
    // {
    //   NAME: 'Project schedule',
    //   SPREADSHEET_ID: 'PASTE_THIRD_SPREADSHEET_ID_HERE',
    //   SHEET_ID: 0, // Only the tab with gid=0 in this spreadsheet.
    // },
  ],
};

const MONITOR_STATE_PREFIX = 'googleSheetNotifier.v2:';
const LEGACY_STATE_KEY = 'googleSheetNotifier.v1';
const MONITOR_HANDLER = 'checkForUpdates';

/** Save fresh baselines without emailing, then schedule this user's checks. */
function installMonitor() {
  withMonitorLock_(function () {
    validateConfig_();
    const baselines = {};
    // Validate access and every selected tab before changing saved state/timers.
    CONFIG.TARGETS.forEach(function (target) {
      const snapshot = readSnapshot_(target);
      if (snapshot.missingTab) {
        throw new Error(targetKey_(target) + ': SHEET_ID does not match a tab. Copy its numeric gid from the URL.');
      }
      baselines[stateKey_(target)] = snapshot.digest;
    });
    // Request mail authorization without sending mail.
    MailApp.getRemainingDailyQuota();
    const properties = PropertiesService.getUserProperties();
    const oldProperties = properties.getProperties();
    const oldTriggers = monitorTriggers_();
    // Create first so a trigger creation failure leaves the existing timer intact.
    const trigger = ScriptApp.newTrigger(MONITOR_HANDLER)
      .timeBased()
      .everyMinutes(CONFIG.CHECK_EVERY_MINUTES)
      .create();
    try {
      properties.setProperties(baselines, false);
    } catch (error) {
      ScriptApp.deleteTrigger(trigger);
      // Restore only the keys this installation tried to write.
      Object.keys(baselines).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(oldProperties, key)) {
          properties.setProperty(key, oldProperties[key]);
        } else {
          properties.deleteProperty(key);
        }
      });
      throw error;
    }
    oldTriggers.forEach(function (oldTrigger) {
      ScriptApp.deleteTrigger(oldTrigger);
    });
    // Remove obsolete monitor state, retaining unrelated user properties.
    Object.keys(oldProperties).forEach(function (key) {
      if (key === LEGACY_STATE_KEY
          || (key.indexOf(MONITOR_STATE_PREFIX) === 0
            && !Object.prototype.hasOwnProperty.call(baselines, key))) {
        properties.deleteProperty(key);
      }
    });
    console.log('Monitor installed for ' + CONFIG.TARGETS.length + ' target(s). Baselines saved; no email sent.');
  });
}

/** Called by the timer; safe to run manually to check immediately. */
function checkForUpdates() {
  withMonitorLock_(function () {
    validateConfig_();
    const properties = PropertiesService.getUserProperties();
    const saved = properties.getProperties();
    const errors = [];
    CONFIG.TARGETS.forEach(function (target) {
      try {
        const previousDigest = saved[stateKey_(target)];
        if (typeof previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(previousDigest)) {
          throw new Error('Missing or invalid baseline. Run installMonitor after updating CONFIG.');
        }
        const snapshot = readSnapshot_(target);
        if (snapshot.digest === previousDigest) {
          console.log('No changes: ' + targetKey_(target));
          return;
        }
        sendNotification_(snapshot, false);
        // Save this target immediately. A failed send leaves its baseline intact.
        // If mail succeeds but saving fails, a later check may repeat the email.
        properties.setProperty(stateKey_(target), snapshot.digest);
        console.log('Change notification sent: ' + targetKey_(target));
      } catch (error) {
        const message = targetKey_(target) + ': ' + String(error.message || error);
        console.error(message);
        errors.push(message);
      }
    });
    // Report failures only AFTER the other targets have been checked.
    if (errors.length) {
      throw new Error('Some targets could not be checked or notified:\n' + errors.join('\n'));
    }
  });
}

/** Send one test email per target; do not change baselines or install a timer. */
function sendTestEmail() {
  withMonitorLock_(function () {
    validateConfig_();
    const errors = [];
    CONFIG.TARGETS.forEach(function (target) {
      try {
        sendNotification_(readSnapshot_(target), true);
        console.log('Test email sent: ' + targetKey_(target));
      } catch (error) {
        errors.push(targetKey_(target) + ': ' + String(error.message || error));
      }
    });
    if (errors.length) {
      throw new Error('Some test emails failed:\n' + errors.join('\n'));
    }
  });
}

/** Stop this user's monitor; leave unrelated triggers and properties alone. */
function uninstallMonitor() {
  withMonitorLock_(function () {
    monitorTriggers_().forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
    const properties = PropertiesService.getUserProperties();
    Object.keys(properties.getProperties()).forEach(function (key) {
      if (key === LEGACY_STATE_KEY || key.indexOf(MONITOR_STATE_PREFIX) === 0) {
        properties.deleteProperty(key);
      }
    });
    console.log('Monitor removed.');
  });
}

function readSnapshot_(target) {
  const spreadsheet = SpreadsheetApp.openById(target.SPREADSHEET_ID);
  const title = spreadsheet.getName();
  let sheets = spreadsheet.getSheets();
  if (target.SHEET_ID !== null) {
    sheets = sheets.filter(function (sheet) {
      return sheet.getSheetId() === target.SHEET_ID;
    });
  }
  // An empty selection after installation represents deletion of the watched tab.
  const missingTab = target.SHEET_ID !== null && sheets.length === 0;
  const content = sheets.map(function (sheet) {
    const range = sheet.getDataRange();
    const values = range.getValues().map(function (row) {
      return row.map(function (value) {
        // Preserve the distinction between a date cell and ISO-formatted text.
        return value instanceof Date ? { date: value.toISOString() } : value;
      });
    });
    return {
      id: sheet.getSheetId(),
      name: sheet.getName(),
      rows: sheet.getMaxRows(),
      columns: sheet.getMaxColumns(),
      values: hash_(values),
      formulas: hash_(range.getFormulas()),
    };
  });
  const scope = target.SHEET_ID === null
    ? 'All tabs'
    : missingTab ? 'Watched tab was deleted (gid=' + target.SHEET_ID + ')'
      : 'Tab: ' + sheets[0].getName();
  return {
    digest: hash_({ title: title, sheets: content }),
    // A custom name labels notifications; changing it is not a sheet edit.
    monitorName: typeof target.NAME === 'string' && target.NAME.trim()
      ? target.NAME.trim() : title,
    title: title,
    scope: scope,
    missingTab: missingTab,
    url: 'https://docs.google.com/spreadsheets/d/' + target.SPREADSHEET_ID + '/edit'
      + (target.SHEET_ID === null ? '' : '#gid=' + target.SHEET_ID),
  };
}

function sendNotification_(snapshot, isTest) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('Daily email quota exhausted. Baseline unchanged; a later check can retry.');
  }
  const heading = isTest ? 'Test notification' : 'Google Sheet updated';
  MailApp.sendEmail({
    to: CONFIG.RECIPIENT_EMAIL,
    subject: (heading + ': ' + snapshot.title).replace(/[\r\n]/g, ' ').slice(0, 200),
    subject: (heading + ': ' + snapshot.monitorName).replace(/[\r\n]/g, ' ').slice(0, 200),
    body: [
      isTest ? 'Your Google Sheet notification script can send email.'
        : 'A change was detected in a monitored Google Sheet.',
      '',
      'Spreadsheet: ' + snapshot.title,
      'Spreadsheet: ' + snapshot.monitorName,
      'Google Sheets title: ' + snapshot.title,
      'Scope: ' + snapshot.scope,
      'Checked at (UTC): ' + new Date().toISOString(),
      '',
      snapshot.url,
      '',
      'Checks run approximately every ' + CONFIG.CHECK_EVERY_MINUTES + ' minute(s).',
      'Several edits to this target between checks are grouped into one notification.',
    ].join('\n'),
    name: 'Google Sheet Monitor',
  });
}

function targetKey_(target) {
  return target.SPREADSHEET_ID + ':' + (target.SHEET_ID === null ? 'all' : target.SHEET_ID);
}

function stateKey_(target) {
  // Store one small fingerprint per target, never the sheet's cell contents.
  return MONITOR_STATE_PREFIX + targetKey_(target);
}

function monitorTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === MONITOR_HANDLER;
  });
}

function withMonitorLock_(action) {
  const lock = LockService.getUserLock();
  lock.waitLock(30000);
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

function hash_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
}

function validateConfig_() {
  if (typeof CONFIG.RECIPIENT_EMAIL !== 'string'
      || CONFIG.RECIPIENT_EMAIL === 'you@example.com'
      || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(CONFIG.RECIPIENT_EMAIL)) {
    throw new Error('Set RECIPIENT_EMAIL to your single email address.');
  }
  if ([1, 5, 10, 15, 30].indexOf(CONFIG.CHECK_EVERY_MINUTES) === -1) {
    throw new Error('CHECK_EVERY_MINUTES must be 1, 5, 10, 15, or 30.');
  }
  if (!Array.isArray(CONFIG.TARGETS) || CONFIG.TARGETS.length === 0) {
    throw new Error('Add at least one spreadsheet to CONFIG.TARGETS.');
  }
  const seen = {};
  CONFIG.TARGETS.forEach(function (target, index) {
    const label = 'TARGETS entry ' + (index + 1);
    if (!target || typeof target.SPREADSHEET_ID !== 'string'
        || /^PASTE_/.test(target.SPREADSHEET_ID)
        || !/^[A-Za-z0-9_-]+$/.test(target.SPREADSHEET_ID)) {
      throw new Error(label + ': set SPREADSHEET_ID to the ID between /d/ and /edit in the URL.');
    }
    if (target.NAME !== undefined && typeof target.NAME !== 'string') {
      throw new Error(label + ': NAME must be text. Leave it blank or omit it to use the spreadsheet title.');
    }
    if (target.SHEET_ID !== null
        && (!Number.isSafeInteger(target.SHEET_ID) || target.SHEET_ID < 0)) {
      throw new Error(label + ': SHEET_ID must be null for all tabs, or a nonnegative numeric gid (including 0).');
    }
    const key = targetKey_(target);
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      throw new Error(label + ': duplicate spreadsheet/tab target: ' + key);
    }
    seen[key] = true;
  });
}