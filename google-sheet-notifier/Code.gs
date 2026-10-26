/**
 * Email notifications for a Google spreadsheet or one of its tabs.
 * Paste into a standalone project at https://script.google.com/.
 * Set CONFIG, then run installMonitor once. See README.md for setup.
 */
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE', // Accepts the ID or the full Google Sheets URL.
  RECIPIENT_EMAIL: 'you@example.com',
  SHEET_ID: null, // null = every tab; use the numeric gid from the URL for one tab.
  CHECK_EVERY_MINUTES: 1, // Allowed: 1, 5, 10, 15, 30.
};

const MONITOR_STATE_KEY = 'googleSheetNotifier.v1';
const MONITOR_HANDLER = 'checkForUpdates';

/** Save a baseline without emailing, then schedule checks under your account. */
function installMonitor() {
  withMonitorLock_(function () {
    validateConfig_();
    const snapshot = readSnapshot_();
    if (snapshot.missingTab) {
      throw new Error('SHEET_ID does not match a tab. Copy its numeric gid from the sheet URL.');
    }
    // Request mail authorization during interactive setup, without sending mail.
    MailApp.getRemainingDailyQuota();
    const oldTriggers = monitorTriggers_();
    // Create first so a trigger creation failure leaves an existing monitor intact.
    const trigger = ScriptApp.newTrigger(MONITOR_HANDLER)
      .timeBased()
      .everyMinutes(CONFIG.CHECK_EVERY_MINUTES)
      .create();
    try {
      saveSnapshot_(snapshot);
    } catch (error) {
      ScriptApp.deleteTrigger(trigger);
      throw error;
    }
    oldTriggers.forEach(function (oldTrigger) {
      ScriptApp.deleteTrigger(oldTrigger);
    });
    console.log('Monitor installed. Baseline saved; no email sent.');
  });
}

/** Called by the timer; safe to run manually to check immediately. */
function checkForUpdates() {
  withMonitorLock_(function () {
    validateConfig_();
    const saved = PropertiesService.getUserProperties().getProperty(MONITOR_STATE_KEY);
    if (!saved) {
      throw new Error('Run installMonitor first to save a baseline and enable monitoring.');
    }
    const previous = JSON.parse(saved);
    if (previous.target !== targetKey_()) {
      throw new Error('The monitored spreadsheet/tab changed. Run installMonitor again.');
    }
    const snapshot = readSnapshot_();
    if (snapshot.digest === previous.digest) {
      console.log('No changes detected.');
      return;
    }
    sendNotification_(snapshot, false);
    // Keep the old state if sending fails, so a later check can retry.
    saveSnapshot_(snapshot);
    console.log('Change notification sent.');
  });
}

/** Send one test email without altering the baseline or installing a timer. */
function sendTestEmail() {
  validateConfig_();
  sendNotification_(readSnapshot_(), true);
  console.log('Test email sent.');
}

/** Stop this user's monitor; leave unrelated triggers and properties alone. */
function uninstallMonitor() {
  withMonitorLock_(function () {
    monitorTriggers_().forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
    PropertiesService.getUserProperties().deleteProperty(MONITOR_STATE_KEY);
    console.log('Monitor removed.');
  });
}

function readSnapshot_() {
  const spreadsheetId = spreadsheetId_();
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const title = spreadsheet.getName();
  let sheets = spreadsheet.getSheets();
  if (CONFIG.SHEET_ID !== null) {
    sheets = sheets.filter(function (sheet) {
      return sheet.getSheetId() === CONFIG.SHEET_ID;
    });
  }
  // An empty selection after installation represents deletion of the watched tab.
  const missingTab = CONFIG.SHEET_ID !== null && sheets.length === 0;
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
  const scope = CONFIG.SHEET_ID === null
    ? 'All tabs'
    : missingTab ? 'Watched tab was deleted (gid=' + CONFIG.SHEET_ID + ')'
      : 'Tab: ' + sheets[0].getName();
  return {
    digest: hash_({ title: title, sheets: content }),
    title: title,
    scope: scope,
    missingTab: missingTab,
    url: 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit'
      + (CONFIG.SHEET_ID === null ? '' : '#gid=' + CONFIG.SHEET_ID),
  };
}

function sendNotification_(snapshot, isTest) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('Daily email quota exhausted. The baseline is unchanged; a later check will retry.');
  }
  const heading = isTest ? 'Test notification' : 'Google Sheet updated';
  MailApp.sendEmail({
    to: CONFIG.RECIPIENT_EMAIL,
    subject: (heading + ': ' + snapshot.title).replace(/[\r\n]/g, ' ').slice(0, 200),
    body: [
      isTest ? 'Your Google Sheet notification script can send email.'
        : 'A change was detected in the monitored Google Sheet.',
      '',
      'Spreadsheet: ' + snapshot.title,
      'Scope: ' + snapshot.scope,
      'Checked at (UTC): ' + new Date().toISOString(),
      '',
      snapshot.url,
      '',
      'Checks run approximately every ' + CONFIG.CHECK_EVERY_MINUTES + ' minute(s).',
      'Several edits between checks are grouped into one notification.',
    ].join('\n'),
    name: 'Google Sheet Monitor',
  });
}

function saveSnapshot_(snapshot) {
  // Store only a small fingerprint, never the sheet's cell contents.
  PropertiesService.getUserProperties().setProperty(MONITOR_STATE_KEY, JSON.stringify({
    target: targetKey_(),
    digest: snapshot.digest,
  }));
}

function targetKey_() {
  return spreadsheetId_() + ':' + (CONFIG.SHEET_ID === null ? 'all' : CONFIG.SHEET_ID);
}

function spreadsheetId_() {
  const input = typeof CONFIG.SPREADSHEET_ID === 'string' ? CONFIG.SPREADSHEET_ID.trim() : '';
  const url = input.match(/^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|[?#]|$)/);
  const id = url ? url[1] : input;
  if (/^\d+$/.test(id)) {
    throw new Error('SPREADSHEET_ID needs the long ID between /d/ and /edit, or the full sheet URL. '
      + 'The numeric gid identifies a tab and belongs in SHEET_ID.');
  }
  if (id === 'PASTE_SPREADSHEET_ID_HERE' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('Set SPREADSHEET_ID to the full Google Sheets URL, or the ID between /d/ and /edit.');
  }
  return id;
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
  spreadsheetId_();
  if (typeof CONFIG.RECIPIENT_EMAIL !== 'string'
      || CONFIG.RECIPIENT_EMAIL === 'you@example.com'
      || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(CONFIG.RECIPIENT_EMAIL)) {
    throw new Error('Set RECIPIENT_EMAIL to your single email address.');
  }
  if (CONFIG.SHEET_ID !== null && (!Number.isSafeInteger(CONFIG.SHEET_ID) || CONFIG.SHEET_ID < 0)) {
    throw new Error('SHEET_ID must be null for all tabs, or a nonnegative numeric gid (including 0).');
  }
  if ([1, 5, 10, 15, 30].indexOf(CONFIG.CHECK_EVERY_MINUTES) === -1) {
    throw new Error('CHECK_EVERY_MINUTES must be 1, 5, 10, 15, or 30.');
  }
}
