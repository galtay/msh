/**
 * House Hunt backend. Paste this into Extensions → Apps Script of the
 * spreadsheet that stores the data, then deploy as a web app (see README).
 *
 * Storage layout (matches the original family sheet, so its data imports as-is):
 *   - one tab per list, named as in TABS below (matched ignoring case/spaces)
 *   - row 1 is headers; columns A–J are FIELDS in order
 *   - column K holds a unique ID per house, filled in automatically
 *   - column L holds the 👍/👎 ratings of each note, as JSON, e.g. {"shirley":"+","martin":"-"}
 *   - a hidden "Backups" tab holds hourly snapshots (see the backups section)
 *
 * The password lives in Project Settings → Script properties as PASSWORD.
 *
 * @OnlyCurrentDoc  Limits the script's permission to this one spreadsheet,
 *                  rather than every spreadsheet in the owner's Drive.
 */

// Bump when this file changes. A plain GET of the web app URL shows it (no
// password needed), and the app warns when the deployed script is too old.
var VERSION = 3;

var TABS = {
  possible: 'house possibilities',
  visited: 'visited',
  rejected: 'rejected no visit',
};

var FIELDS = ['name', 'location', 'price', 'link', 'distShrewsbury', 'distLudlow',
  'shirley', 'martin', 'actions', 'agent'];
var LINK_COL = FIELDS.indexOf('link') + 1;
var PRICE_COL = FIELDS.indexOf('price') + 1;
var PRICE_FORMAT = '"£"#,##0';
var ID_COL = FIELDS.length + 1;
var RATINGS_COL = ID_COL + 1;
var LAST_COL = RATINGS_COL;
var HEADERS = ['House name', 'Location', 'Price', 'Link', 'Distance to Shrewsbury',
  'Distance to Ludlow', "Mum's initial thoughts", "Dad's initial thoughts",
  'Actions taken and decision made', 'Estate agent contact', 'ID', 'Ratings'];
var MAX_TEXT = 10000; // per field; generous for notes, stops runaway input

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('PASSWORD');
    if (!expected) throw new Error('No PASSWORD set in Script properties');
    if (req.password !== expected) {
      Utilities.sleep(1000); // slow down guessing
      return json_({ ok: false, auth: true, error: 'Wrong password' });
    }
    switch (req.action) {
      case 'list':
        return json_({ ok: true, version: VERSION, houses: listAll_() });
      case 'create':
        return json_({ ok: true, house: withLock_(function () { return create_(req.house); }) });
      case 'update':
        return json_({ ok: true, house: withLock_(function () { return update_(req.id, req.changes); }) });
      case 'save': // whole-house saves from app versions before VERSION 3
        return json_({ ok: true, house: withLock_(function () {
          var h = req.house || {};
          return h.id ? update_(h.id, h) : create_(h);
        }) });
      case 'delete':
        withLock_(function () { delete_(req.id); });
        return json_({ ok: true });
      default:
        throw new Error('Unknown action: ' + req.action);
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('House Hunt API version ' + VERSION + ' is running.');
}

// ---------- operations ----------

function listAll_() {
  var houses = [];
  Object.keys(TABS).forEach(function (status) {
    var sheet = sheetFor_(status);
    var n = sheet.getLastRow() - 1;
    if (n < 1) return;
    var values = sheet.getRange(2, 1, n, LAST_COL).getDisplayValues();
    var links = sheet.getRange(2, LINK_COL, n, 1).getRichTextValues();
    var idsChanged = false;

    values.forEach(function (row, i) {
      var isBlank = row.slice(0, FIELDS.length).every(function (v) { return v === ''; });
      if (isBlank) return;
      if (!row[ID_COL - 1]) { row[ID_COL - 1] = Utilities.getUuid(); idsChanged = true; }
      houses.push(toHouse_(row, links[i][0], status));
    });

    if (idsChanged) {
      sheet.getRange(2, ID_COL, n, 1).setValues(values.map(function (r) { return [r[ID_COL - 1]]; }));
    }
  });
  return houses;
}

function create_(house) {
  house = house || {};
  var status = house.status || 'possible';
  if (!TABS[status]) throw new Error('Unknown group: ' + status);
  var row = FIELDS.map(function (f) { return cell_(f, house[f]); });
  row.push(Utilities.getUuid());
  row.push(mergeRatings_('', house.ratings));
  var sheet = sheetFor_(status);
  var at = sheet.getLastRow() + 1;
  writeRows_(sheet, at, [row]);
  return readHouse_(sheet, at, status);
}

// Applies only the given changes, so two devices editing different things on
// the same house don't overwrite each other. `changes` may hold any of FIELDS,
// `status` (moves the row to that tab) and `ratings` (an object merged into the
// stored ratings, e.g. {"shirley": "+", "martin": null}; a string replaces them).
function update_(id, changes) {
  if (!id) throw new Error('Missing house id');
  changes = changes || {};
  var found = locate_(id);
  if (!found) throw new Error('That house is no longer in the sheet (deleted on another device?). Tap ⟳ to refresh.');
  var status = changes.status || found.status;
  if (!TABS[status]) throw new Error('Unknown group: ' + status);

  var range = found.sheet.getRange(found.row, 1, 1, LAST_COL);
  var row = range.getValues()[0];
  // Keep a rich-text link's real URL rather than its display text.
  var link = range.getCell(1, LINK_COL).getRichTextValue();
  var linkUrl = link && link.getLinkUrl();
  if (linkUrl) row[LINK_COL - 1] = linkUrl;

  FIELDS.forEach(function (f, c) {
    if (Object.prototype.hasOwnProperty.call(changes, f)) row[c] = changes[f];
  });
  if (changes.ratings !== undefined) row[RATINGS_COL - 1] = mergeRatings_(row[RATINGS_COL - 1], changes.ratings);
  var out = toCells_(row);

  if (status === found.status) {
    writeRows_(found.sheet, found.row, [out]);
    return readHouse_(found.sheet, found.row, status);
  }
  var target = sheetFor_(status);
  var at = target.getLastRow() + 1;
  writeRows_(target, at, [out]);
  found.sheet.deleteRow(found.row);
  return readHouse_(target, at, status);
}

function delete_(id) {
  var found = locate_(id);
  if (found) found.sheet.deleteRow(found.row); // already gone is fine
}

// ---------- cells ----------

// Text goes in with a leading apostrophe so Sheets keeps it exactly as typed:
// no formulas from "=…" or "+…", no dates from "10/14", no lost leading zero
// on "01743…". Prices that look like amounts stay numbers so they format as £.
function cell_(field, value) {
  var s = value === null || value === undefined ? '' : String(value);
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
  if (s.trim() === '') return '';
  if (field === 'price' && /^£?\s*\d[\d,]*(\.\d+)?$/.test(s.trim())) return s.trim();
  return "'" + s;
}

// Writes whole rows, and shows prices as £ (fresh rows have no format of their own).
function writeRows_(sheet, at, rows) {
  sheet.getRange(at, 1, rows.length, LAST_COL).setValues(rows);
  sheet.getRange(at, PRICE_COL, rows.length, 1).setNumberFormat(PRICE_FORMAT);
}

// A whole stored row back into writable cells: text is re-escaped, numbers
// (e.g. prices) and the ID/ratings columns go back as they are.
function toCells_(row) {
  return row.map(function (v, i) {
    if (i < FIELDS.length) return typeof v === 'string' ? cell_(FIELDS[i], v) : v;
    return v === null || v === undefined ? '' : v;
  });
}

function mergeRatings_(current, patch) {
  var r = typeof patch === 'string' ? parseRatings_(patch) : parseRatings_(current);
  if (patch && typeof patch === 'object') {
    Object.keys(patch).forEach(function (k) {
      if (patch[k] === '+' || patch[k] === '-') r[k] = patch[k]; else delete r[k];
    });
  }
  Object.keys(r).forEach(function (k) {
    if (FIELDS.indexOf(k) < 0 || (r[k] !== '+' && r[k] !== '-')) delete r[k];
  });
  return Object.keys(r).length ? JSON.stringify(r) : '';
}

function parseRatings_(s) {
  try {
    var o = JSON.parse(s || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

function toHouse_(displayRow, richLink, status) {
  var house = { id: displayRow[ID_COL - 1], status: status };
  FIELDS.forEach(function (f, c) { house[f] = displayRow[c]; });
  house.ratings = displayRow[RATINGS_COL - 1];
  var url = richLink && richLink.getLinkUrl();
  if (url) house.link = url;
  return house;
}

function readHouse_(sheet, row, status) {
  var range = sheet.getRange(row, 1, 1, LAST_COL);
  return toHouse_(range.getDisplayValues()[0], range.getCell(1, LINK_COL).getRichTextValue(), status);
}

// ---------- tabs ----------

function locate_(id) {
  var statuses = Object.keys(TABS);
  for (var s = 0; s < statuses.length; s++) {
    var sheet = sheetFor_(statuses[s]);
    var n = sheet.getLastRow() - 1;
    if (n < 1) continue;
    var ids = sheet.getRange(2, ID_COL, n, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === id) return { sheet: sheet, row: i + 2, status: statuses[s] };
    }
  }
  return null;
}

function sheetFor_(status) {
  var want = norm_(TABS[status]);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (norm_(sheets[i].getName()) === want) return ensureColumns_(sheets[i]);
  }
  var sheet = ss.insertSheet(TABS[status]);
  sheet.appendRow(HEADERS);
  return ensureColumns_(sheet);
}

// Tabs made before a column was added may be too narrow or lack its header.
// Checked once per request (each request is a fresh script run).
var columnsChecked_ = {};
function ensureColumns_(sheet) {
  if (columnsChecked_[sheet.getSheetId()]) return sheet;
  columnsChecked_[sheet.getSheetId()] = true;
  var have = sheet.getMaxColumns();
  if (have < LAST_COL) sheet.insertColumnsAfter(have, LAST_COL - have);
  var current = sheet.getRange(1, 1, 1, LAST_COL).getValues()[0];
  if (current[ID_COL - 1] === '' || current[RATINGS_COL - 1] === '') {
    sheet.getRange(1, ID_COL, 1, 2).setValues([[HEADERS[ID_COL - 1], HEADERS[RATINGS_COL - 1]]]);
  }
  return sheet;
}

function norm_(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- backups ----------
// Snapshots of all three tabs go in a hidden "Backups" tab inside this same
// spreadsheet (so the script still needs no wider Drive access). Each row is:
// time, number of houses, fingerprint, then the snapshot as JSON split across
// as many cells as needed (a cell holds at most 50,000 characters).
// Use the House Hunt menu in the sheet to back up, restore, or turn on hourly backups.

var BACKUP_TAB = 'Backups';
var BACKUP_KEEP = 24 * 7; // a week of hourly snapshots
var BACKUP_CHUNK = 45000;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('House Hunt')
    .addItem('Back up now', 'backupNow')
    .addItem('Restore selected backup…', 'restoreSelectedBackup')
    .addSeparator()
    .addItem('Turn on hourly backups', 'turnOnHourlyBackups')
    .addToUi();
}

// Runs every hour once turned on. Skips the snapshot if nothing has changed.
function hourlyBackup() {
  withLock_(function () { backup_(false); });
}

function backupNow() {
  var made = withLock_(function () { return backup_(true); });
  SpreadsheetApp.getUi().alert('Backed up ' + made.count + ' houses at ' + made.time + '.');
}

function turnOnHourlyBackups() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'hourlyBackup';
  });
  if (!exists) ScriptApp.newTrigger('hourlyBackup').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert(exists ? 'Hourly backups were already on.' : 'Hourly backups are on.');
}

function restoreSelectedBackup() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveRange() ? sheet.getActiveRange().getRow() : 0;
  if (sheet.getName() !== BACKUP_TAB || row < 2) {
    ui.alert('Open the Backups tab (View → Hidden sheets if it is hidden), click a row, then try again.');
    return;
  }
  var when = sheet.getRange(row, 1).getDisplayValue();
  var answer = ui.alert('Restore the backup from ' + when + '?',
    'This replaces everything in the three house tabs. The current data is backed up first, so this can be undone.',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  var result = withLock_(function () { return restoreBackupRow_(row); });
  ui.alert('Restored ' + result.count + ' houses from ' + when + '.');
}

// Returns {time, count}. When `force` is false and the data matches the most
// recent snapshot, nothing is written.
function backup_(force) {
  var snapshot = { version: 1, tabs: {} };
  var count = 0;
  Object.keys(TABS).forEach(function (status) {
    var sheet = sheetFor_(status);
    var n = sheet.getLastRow() - 1;
    var rows = n > 0 ? sheet.getRange(2, 1, n, LAST_COL).getValues() : [];
    snapshot.tabs[status] = rows;
    count += rows.length;
  });
  var json = JSON.stringify(snapshot);
  var fingerprint = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, json));
  var tab = backupTab_();
  var time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  if (!force && tab.getLastRow() >= 2 && tab.getRange(2, 3).getValue() === fingerprint) {
    return { time: time, count: count, skipped: true };
  }
  var chunks = [];
  for (var i = 0; i < json.length; i += BACKUP_CHUNK) chunks.push(json.slice(i, i + BACKUP_CHUNK));
  // Newest first, straight under the header.
  tab.insertRowBefore(2);
  var row = [time, count, fingerprint].concat(chunks);
  if (tab.getMaxColumns() < row.length) tab.insertColumnsAfter(tab.getMaxColumns(), row.length - tab.getMaxColumns());
  tab.getRange(2, 1, 1, row.length).setValues([row.map(function (v, i) { return i >= 3 ? "'" + v : v; })]);
  var extra = tab.getLastRow() - 1 - BACKUP_KEEP;
  if (extra > 0) tab.deleteRows(BACKUP_KEEP + 2, extra);
  return { time: time, count: count };
}

function restoreBackupRow_(row) {
  var tab = backupTab_();
  var cells = tab.getRange(row, 1, 1, tab.getLastColumn()).getValues()[0];
  var json = cells.slice(3).filter(function (c) { return c !== ''; }).join('');
  var snapshot = JSON.parse(json);
  if (!snapshot || !snapshot.tabs) throw new Error('That row is not a backup.');
  backup_(true); // so this restore can itself be undone
  var count = 0;
  Object.keys(TABS).forEach(function (status) {
    var sheet = sheetFor_(status);
    var n = sheet.getLastRow() - 1;
    if (n > 0) sheet.deleteRows(2, n);
    var rows = (snapshot.tabs[status] || []).map(function (r) {
      var full = r.slice(0, LAST_COL);
      while (full.length < LAST_COL) full.push('');
      return toCells_(full);
    });
    if (rows.length) writeRows_(sheet, 2, rows);
    count += rows.length;
  });
  return { count: count };
}

function backupTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(BACKUP_TAB);
  if (!tab) {
    tab = ss.insertSheet(BACKUP_TAB);
    tab.appendRow(['Time', 'Houses', 'Fingerprint', 'Snapshot (JSON, continues across columns)']);
    tab.hideSheet();
  }
  return tab;
}
