const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, 'Code.gs'), 'utf8');

function makeSheet(id = 0, name = 'Sheet1') {
  return {
    id, name, rows: 1000, columns: 26, values: [['Initial value']], formulas: [['']],
    getSheetId() { return this.id; },
    getName() { return this.name; },
    getMaxRows() { return this.rows; },
    getMaxColumns() { return this.columns; },
    getDataRange() {
      return { getValues: () => this.values, getFormulas: () => this.formulas };
    },
  };
}

function fixture() {
  const state = {
    title: 'Budget 日本語', sheets: [makeSheet()], emails: [], properties: new Map(),
    triggers: [], quota: 100, locked: false, failRead: false, failSend: false,
    failCreate: false, failSave: false,
  };
  const properties = {
    getProperty: key => state.properties.get(key) ?? null,
    setProperty(key, value) {
      if (state.failSave) throw new Error('Storage unavailable');
      state.properties.set(key, value);
    },
    deleteProperty: key => state.properties.delete(key),
  };
  const context = vm.createContext({
    Date,
    console: { log() {} },
    SpreadsheetApp: {
      openById(id) {
        assert.equal(id, 'test_sheet_id');
        if (state.failRead) throw new Error('Access denied');
        return { getName: () => state.title, getSheets: () => state.sheets.slice() };
      },
    },
    PropertiesService: { getUserProperties: () => properties },
    LockService: {
      getUserLock: () => ({
        waitLock() {
          if (state.locked) throw new Error('Lock unavailable');
          state.locked = true;
        },
        releaseLock() { state.locked = false; },
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger: trigger => { state.triggers = state.triggers.filter(t => t !== trigger); },
      newTrigger(handler) {
        const builder = {
          timeBased() { return this; },
          everyMinutes(minutes) { this.minutes = minutes; return this; },
          create() {
            if (state.failCreate) throw new Error('Trigger quota exceeded');
            const trigger = { getHandlerFunction: () => handler, minutes: this.minutes };
            state.triggers.push(trigger);
            return trigger;
          },
        };
        return builder;
      },
    },
    MailApp: {
      getRemainingDailyQuota: () => state.quota,
      sendEmail(message) {
        if (state.failSend) throw new Error('Mail unavailable');
        assert.ok(state.quota > 0);
        state.emails.push(message);
        state.quota--;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value, charset) => Array.from(
        createHash(algorithm).update(value, charset).digest(),
        byte => byte > 127 ? byte - 256 : byte
      ),
    },
  });
  vm.runInContext(source, context);
  const config = vm.runInContext('CONFIG', context);
  Object.assign(config, { SPREADSHEET_ID: 'test_sheet_id', RECIPIENT_EMAIL: 'owner@example.org' });
  return { state, config, app: context, baseline: () => Array.from(state.properties.entries()) };
}

test('installation and unchanged checks send no emails; reinstall replaces only its timer', () => {
  const { state, app } = fixture();
  const unrelated = { getHandlerFunction: () => 'otherJob' };
  state.triggers.push(unrelated);
  app.installMonitor();
  app.checkForUpdates();
  app.checkForUpdates();
  app.installMonitor();
  assert.equal(state.emails.length, 0);
  assert.equal(state.triggers.length, 2);
  assert.ok(state.triggers.includes(unrelated));
  assert.equal(state.triggers[1].minutes, 1);
});

test('a batch of cell changes sends once; messages and saved state exclude cell data', () => {
  const { state, app, baseline } = fixture();
  app.installMonitor();
  state.sheets[0].values = [['confidential new value', 42, true], ['', 0, false]];
  app.checkForUpdates();
  app.checkForUpdates();
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].to, 'owner@example.org');
  assert.match(state.emails[0].body, /Budget 日本語/);
  assert.match(state.emails[0].body, /https:\/\/docs.google.com\/spreadsheets\/d\/test_sheet_id\/edit/);
  assert.doesNotMatch(state.emails[0].body, /confidential new value/);
  assert.doesNotMatch(JSON.stringify(baseline()), /confidential new value/);
});

for (const [name, change] of Object.entries({
  'formula text with unchanged results': s => { s.sheets[0].formulas = [['="Initial value"']]; },
  'tab rename': s => { s.sheets[0].name = 'Renamed'; },
  'blank row insertion': s => { s.sheets[0].rows++; },
  'blank column deletion': s => { s.sheets[0].columns--; },
  'spreadsheet rename': s => { s.title = 'New title'; },
  'tab addition': s => { s.sheets.push(makeSheet(123, 'New tab')); },
  'cleared contents': s => { s.sheets[0].values = [['']]; },
})) {
  test(`detects ${name}`, () => {
    const { state, app } = fixture();
    app.installMonitor();
    change(state);
    app.checkForUpdates();
    assert.equal(state.emails.length, 1);
  });
}

test('detects tab reordering and removal when watching all tabs', () => {
  const { state, app } = fixture();
  state.sheets.push(makeSheet(123, 'Second tab'));
  app.installMonitor();
  state.sheets.reverse();
  app.checkForUpdates();
  state.sheets.pop();
  app.checkForUpdates();
  assert.equal(state.emails.length, 2);
});

test('a date and identical ISO text are distinct; stable dates do not cause repeats', () => {
  const { state, app } = fixture();
  const date = new Date('2026-10-15T12:00:00Z');
  state.sheets[0].values = [[date]];
  app.installMonitor();
  app.checkForUpdates();
  assert.equal(state.emails.length, 0);
  state.sheets[0].values = [[date.toISOString()]];
  app.checkForUpdates();
  assert.equal(state.emails.length, 1);
});

test('gid 0 ignores other tabs, follows renames, and reports its deletion once', () => {
  const { state, config, app } = fixture();
  config.SHEET_ID = 0;
  state.sheets.push(makeSheet(123, 'Other tab'));
  app.installMonitor();
  state.sheets[1].values = [['Other change']];
  app.checkForUpdates();
  assert.equal(state.emails.length, 0);
  state.sheets[0].name = 'Renamed';
  app.checkForUpdates();
  assert.match(state.emails[0].body, /Tab: Renamed/);
  assert.match(state.emails[0].body, /#gid=0/);
  state.sheets.shift();
  app.checkForUpdates();
  app.checkForUpdates();
  assert.equal(state.emails.length, 2);
  assert.match(state.emails[1].body, /was deleted/);
});

for (const failure of ['mail', 'quota', 'read']) {
  test(`${failure} failure preserves baseline and releases lock; recovery sends the update`, () => {
    const { state, app, baseline } = fixture();
    app.installMonitor();
    const before = baseline();
    state.sheets[0].values = [['Changed']];
    if (failure === 'mail') state.failSend = true;
    if (failure === 'quota') state.quota = 0;
    if (failure === 'read') state.failRead = true;
    assert.throws(() => app.checkForUpdates(), /unavailable|quota exhausted|Access denied/);
    assert.deepEqual(baseline(), before);
    assert.equal(state.emails.length, 0);
    assert.equal(state.locked, false);
    state.failSend = state.failRead = false;
    state.quota = 100;
    app.checkForUpdates();
    app.checkForUpdates();
    assert.equal(state.emails.length, 1);
  });
}

test('failed reinstallation preserves existing trigger and baseline', () => {
  for (const failure of ['failRead', 'failCreate', 'failSave']) {
    const { state, app, baseline } = fixture();
    app.installMonitor();
    const oldTriggers = state.triggers.slice();
    const before = baseline();
    state.sheets[0].values = [['Pending change']];
    state[failure] = true;
    assert.throws(() => app.installMonitor());
    assert.deepEqual(state.triggers, oldTriggers);
    assert.deepEqual(baseline(), before);
    assert.equal(state.locked, false);
  }
});

test('test email leaves the baseline unchanged; uninstall preserves unrelated state', () => {
  const { state, app, baseline } = fixture();
  const unrelated = { getHandlerFunction: () => 'otherJob' };
  state.triggers.push(unrelated);
  state.properties.set('otherSetting', 'keep');
  app.installMonitor();
  const before = baseline();
  app.sendTestEmail();
  assert.equal(state.emails.length, 1);
  assert.match(state.emails[0].subject, /Test notification/);
  assert.deepEqual(baseline(), before);
  app.uninstallMonitor();
  assert.deepEqual(state.triggers, [unrelated]);
  assert.deepEqual(baseline(), [['otherSetting', 'keep']]);
  assert.throws(() => app.checkForUpdates(), /installMonitor first/);
});

test('invalid configuration cannot install a timer or send mail', () => {
  for (const invalid of [
    { SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE' },
    { SPREADSHEET_ID: 'https://example.org/spreadsheets/d/abc/edit' },
    { SPREADSHEET_ID: '' }, { SPREADSHEET_ID: '123456' }, { SPREADSHEET_ID: 123456 },
    { RECIPIENT_EMAIL: 'you@example.com' },
    { RECIPIENT_EMAIL: 'first@example.org,second@example.org' },
    { SHEET_ID: '0' }, { SHEET_ID: -1 }, { SHEET_ID: 999 },
    { CHECK_EVERY_MINUTES: 2 },
  ]) {
    const { state, config, app } = fixture();
    Object.assign(config, invalid);
    assert.throws(() => app.installMonitor());
    assert.equal(state.triggers.length, 0);
    assert.equal(state.emails.length, 0);
    assert.equal(state.properties.size, 0);
    assert.equal(state.locked, false);
  }
});

test('target changes require explicit reinstallation; concurrent runs cannot send', () => {
  const { state, config, app, baseline } = fixture();
  app.installMonitor();
  const before = baseline();
  config.SHEET_ID = 0;
  assert.throws(() => app.checkForUpdates(), /Run installMonitor again/);
  assert.deepEqual(baseline(), before);
  config.SHEET_ID = null;
  state.sheets[0].values = [['Changed']];
  state.locked = true;
  assert.throws(() => app.checkForUpdates(), /Lock unavailable/);
  assert.equal(state.emails.length, 0);
  assert.deepEqual(baseline(), before);
});

test('full URLs and surrounding whitespace normalize consistently for reads, saved state, and email', () => {
  const { state, config, app, baseline } = fixture();
  app.installMonitor();
  const before = baseline();
  for (const input of [
    '  test_sheet_id\n',
    'https://docs.google.com/spreadsheets/d/test_sheet_id/edit?gid=123#gid=123',
    ' https://docs.google.com/spreadsheets/d/test_sheet_id/edit?usp=sharing ',
    'https://docs.google.com/spreadsheets/u/0/d/test_sheet_id/edit',
    'https://docs.google.com/spreadsheets/d/test_sheet_id',
  ]) {
    config.SPREADSHEET_ID = input;
    app.checkForUpdates();
    assert.deepEqual(baseline(), before);
    assert.equal(state.emails.length, 0);
  }
  config.SPREADSHEET_ID = 'https://docs.google.com/spreadsheets/d/test_sheet_id/edit?gid=0#gid=0';
  config.SHEET_ID = 0;
  app.installMonitor();
  state.sheets[0].values = [['Changed']];
  app.checkForUpdates();
  assert.equal(state.emails.length, 1);
  assert.match(state.emails[0].body, /https:\/\/docs.google.com\/spreadsheets\/d\/test_sheet_id\/edit#gid=0/);
  assert.doesNotMatch(state.emails[0].body, /\/d\/https:/);
});

test('a numeric tab ID produces an actionable error before Google is called', () => {
  const { config, app, state } = fixture();
  config.SPREADSHEET_ID = ' 1182311045 ';
  assert.throws(() => app.installMonitor(), /numeric gid identifies a tab and belongs in SHEET_ID/);
  assert.equal(state.triggers.length, 0);
});
