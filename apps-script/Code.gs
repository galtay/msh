/**
 * House Hunt backend. Paste this into Extensions → Apps Script of the
 * spreadsheet that stores the data, then deploy as a web app (see README).
 *
 * Storage layout (matches the original family sheet, so its data imports as-is):
 *   - one tab per list, named as in TABS below (matched ignoring case/spaces)
 *   - row 1 is headers; columns A–J are FIELDS in order
 *   - column K holds a unique ID per house, filled in automatically
 *   - column L holds the 👍/👎 ratings of each note, as JSON, e.g. {"shirley":"+","martin":"-"}
 *
 * The password lives in Project Settings → Script properties as PASSWORD.
 *
 * @OnlyCurrentDoc  Limits the script's permission to this one spreadsheet,
 *                  rather than every spreadsheet in the owner's Drive.
 */

var TABS = {
  possible: 'house possibilities',
  visited: 'visited',
  rejected: 'rejected no visit',
};

var FIELDS = ['name', 'location', 'price', 'link', 'distShrewsbury', 'distLudlow',
  'shirley', 'martin', 'actions', 'agent'];
var LINK_COL = FIELDS.indexOf('link') + 1;
var ID_COL = FIELDS.length + 1;
var RATINGS_COL = ID_COL + 1;
var LAST_COL = RATINGS_COL;
var HEADERS = ['House name', 'Location', 'Price', 'Link', 'Distance to Shrewsbury',
  'Distance to Ludlow', "Mum's initial thoughts", "Dad's initial thoughts",
  'Actions taken and decision made', 'Estate agent contact', 'ID', 'Ratings'];

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
      case 'list': return json_({ ok: true, houses: listAll_() });
      case 'save': return json_({ ok: true, house: withLock_(function () { return save_(req.house); }) });
      case 'delete': withLock_(function () { delete_(req.id); }); return json_({ ok: true });
      default: throw new Error('Unknown action: ' + req.action);
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// Bump when this file changes, so a plain GET of the web app URL shows
// whether the latest code has been deployed (no password needed).
var VERSION = 2;

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
    var range = sheet.getRange(2, 1, n, LAST_COL);
    var values = range.getDisplayValues();
    // Links pasted as "smart chips" or rich text keep the URL out of the display value.
    var links = sheet.getRange(2, LINK_COL, n, 1).getRichTextValues();
    var idsChanged = false;

    values.forEach(function (row, i) {
      var isBlank = row.slice(0, FIELDS.length).every(function (v) { return v === ''; });
      if (isBlank) return;
      if (!row[ID_COL - 1]) { row[ID_COL - 1] = Utilities.getUuid(); idsChanged = true; }
      var house = { id: row[ID_COL - 1], status: status };
      FIELDS.forEach(function (f, c) { house[f] = row[c]; });
      house.ratings = row[RATINGS_COL - 1];
      var url = links[i][0] && links[i][0].getLinkUrl();
      if (url) house.link = url;
      houses.push(house);
    });

    if (idsChanged) {
      sheet.getRange(2, ID_COL, n, 1).setValues(values.map(function (r) { return [r[ID_COL - 1]]; }));
    }
  });
  return houses;
}

function save_(house) {
  if (!house || !TABS[house.status]) throw new Error('Bad house data');
  var target = sheetFor_(house.status);
  var found = house.id ? locate_(house.id) : null;
  if (!house.id) house.id = Utilities.getUuid();

  var row = FIELDS.map(function (f) { return house[f] == null ? '' : String(house[f]); });
  row.push(house.id);
  row.push(house.ratings == null ? '' : String(house.ratings));

  if (found && found.sheet.getSheetId() === target.getSheetId()) {
    found.sheet.getRange(found.row, 1, 1, LAST_COL).setValues([row]);
  } else {
    target.getRange(target.getLastRow() + 1, 1, 1, LAST_COL).setValues([row]);
    if (found) found.sheet.deleteRow(found.row); // moved to a different list
  }
  return house;
}

function delete_(id) {
  var found = locate_(id);
  if (found) found.sheet.deleteRow(found.row);
}

// ---------- helpers ----------

function locate_(id) {
  var statuses = Object.keys(TABS);
  for (var s = 0; s < statuses.length; s++) {
    var sheet = sheetFor_(statuses[s]);
    var n = sheet.getLastRow() - 1;
    if (n < 1) continue;
    var ids = sheet.getRange(2, ID_COL, n, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === id) return { sheet: sheet, row: i + 2 };
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
