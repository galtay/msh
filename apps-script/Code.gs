/**
 * House Hunt backend. Paste this into Extensions → Apps Script of the
 * spreadsheet that stores the data, then deploy as a web app (see README).
 *
 * Storage layout (matches the original family sheet, so its data imports as-is):
 *   - one tab per group, named as in TABS below (matched ignoring case/spaces);
 *     a missing tab (e.g. Priority, added later) is created with headers
 *   - row 1 is headers; columns A–J are FIELDS in order
 *   - column K holds a unique ID per house, filled in automatically
 *   - column L holds the 👍/👎 ratings of each note, as JSON, e.g. {"shirley":"+","martin":"-"}
 *   - columns M–Q hold what's read from the listing page: main photo, latitude,
 *     longitude, how exact the location is, and when the listing was last read
 *   - a hidden "Backups" tab holds hourly snapshots (see the backups section)
 *
 * The password lives in Project Settings → Script properties as PASSWORD.
 *
 * @OnlyCurrentDoc  Limits the script's permission to this one spreadsheet,
 *                  rather than every spreadsheet in the owner's Drive. (It can
 *                  also fetch web pages, to read listing photos and locations.)
 */

// Bump when this file changes. A plain GET of the web app URL shows it (no
// password needed), and the app warns when the deployed script is too old.
var VERSION = 5;

var TABS = {
  possible: 'house possibilities',
  priority: 'priority',
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
var PHOTO_COL = RATINGS_COL + 1;
var LAT_COL = PHOTO_COL + 1;
var LNG_COL = LAT_COL + 1;
var ACCURACY_COL = LNG_COL + 1;
var CHECKED_COL = ACCURACY_COL + 1;
var LAST_COL = CHECKED_COL;
var HEADERS = ['House name', 'Location', 'Price', 'Link', 'Distance to Shrewsbury',
  'Distance to Ludlow', "Mum's initial thoughts", "Dad's initial thoughts",
  'Actions taken and decision made', 'Estate agent contact', 'ID', 'Ratings',
  'Photo', 'Latitude', 'Longitude', 'Location accuracy', 'Listing checked'];
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
      case 'enrich': // read the photo and location from one house's listing now
        return json_({ ok: true, house: enrichHouse_(req.id) });
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
  while (row.length < LAST_COL) row.push(''); // photo, location etc. are read later
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

  var oldLink = String(row[LINK_COL - 1]);
  FIELDS.forEach(function (f, c) {
    if (Object.prototype.hasOwnProperty.call(changes, f)) row[c] = changes[f];
  });
  // A different listing: forget what was read from the old one.
  if (String(row[LINK_COL - 1]) !== oldLink) {
    for (var c = PHOTO_COL; c <= LAST_COL; c++) row[c - 1] = '';
  }
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

// A whole stored row back into writable cells: text is re-escaped (in every
// column, so e.g. "2026-10-24 17:40 ok" can't turn into a date); numbers such
// as prices go back as they are.
function toCells_(row) {
  return row.map(function (v, i) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? cell_(FIELDS[i] || null, v) : v;
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
  house.photo = displayRow[PHOTO_COL - 1];
  house.lat = displayRow[LAT_COL - 1];
  house.lng = displayRow[LNG_COL - 1];
  house.accuracy = displayRow[ACCURACY_COL - 1];
  house.checked = displayRow[CHECKED_COL - 1];
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
  var missing = false;
  for (var c = ID_COL; c <= LAST_COL; c++) {
    if (current[c - 1] === '') { current[c - 1] = HEADERS[c - 1]; missing = true; }
  }
  if (missing) sheet.getRange(1, ID_COL, 1, LAST_COL - ID_COL + 1).setValues([current.slice(ID_COL - 1)]);
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
    .addItem('Fill in photos & locations now', 'fillListingInfoNow')
    .addToUi();
}

// Runs every hour once turned on: reads photos and locations for a few houses
// that still need them, then takes a snapshot (skipped if nothing changed).
function hourlyBackup() {
  try {
    enrichPending_(LISTING_BATCH);
  } catch (e) {
    console.error('Reading listings failed: ' + e); // never let this stop the backup
  }
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

// ---------- listing photos and locations ----------
// Reads each house's listing page for its main photo and map position.
// Rightmove pages carry both in window.__PAGE_MODEL (see rightmoveInfo_). For
// other sites, the page's sharing image (og:image) is used. With no position
// from the page, the Location text is looked up instead (approximate).
// Pages are fetched outside the lock (it can take a few seconds), then each
// house is found again by ID and only written if its link hasn't changed.

var LISTING_BATCH = 20; // pages per run
var RETRY_FAILED_HOURS = 24;

function enrichHouse_(id) {
  var found = locate_(id);
  if (!found) throw new Error('That house is no longer in the sheet (deleted on another device?). Tap ⟳ to refresh.');
  var job = jobFor_(found);
  saveListingInfo_([job], readListings_([job]));
  var again = locate_(id);
  return readHouse_(again.sheet, again.row, again.status);
}

// Houses with a link or a location that haven't been read yet (or whose last
// attempt failed a while ago), at most `limit`. Returns how many were done.
function enrichPending_(limit) {
  var jobs = [];
  Object.keys(TABS).forEach(function (status) {
    var sheet = sheetFor_(status);
    var n = sheet.getLastRow() - 1;
    if (n < 1) return;
    var rows = sheet.getRange(2, 1, n, LAST_COL).getValues();
    var links = sheet.getRange(2, LINK_COL, n, 1).getRichTextValues();
    rows.forEach(function (row, i) {
      if (jobs.length >= limit || !row[ID_COL - 1]) return;
      if (!needsReading_(row[CHECKED_COL - 1])) return;
      var url = (links[i][0] && links[i][0].getLinkUrl()) || String(row[LINK_COL - 1]);
      if (!url.trim() && !String(row[1]).trim()) return;
      jobs.push({ id: row[ID_COL - 1], url: url.trim(), location: String(row[1]).trim() });
    });
  });
  if (jobs.length) saveListingInfo_(jobs, readListings_(jobs));
  return jobs.length;
}

function fillListingInfoNow() {
  var done = 0;
  var started = Date.now();
  // Apps Script stops a run after 6 minutes; stop well before.
  while (Date.now() - started < 4 * 60 * 1000) {
    var n = enrichPending_(LISTING_BATCH);
    done += n;
    if (n < LISTING_BATCH) break;
  }
  SpreadsheetApp.getUi().alert('Read the listings of ' + done + ' houses.');
}

function needsReading_(checked) {
  var s = String(checked || '');
  if (!s) return true;
  if (s.indexOf('failed') < 0) return false;
  var when = new Date(s.slice(0, 16).replace(' ', 'T'));
  return isNaN(when) || Date.now() - when.getTime() > RETRY_FAILED_HOURS * 3600 * 1000;
}

function jobFor_(found) {
  var range = found.sheet.getRange(found.row, 1, 1, LAST_COL);
  var row = range.getValues()[0];
  var rich = range.getCell(1, LINK_COL).getRichTextValue();
  var url = (rich && rich.getLinkUrl()) || String(row[LINK_COL - 1]);
  return { id: row[ID_COL - 1], url: url.trim(), location: String(row[1]).trim() };
}

// Fetches the pages (in parallel) and works out {photo, lat, lng, accuracy, result}.
function readListings_(jobs) {
  var withUrl = jobs.filter(function (j) { return /^https?:\/\//i.test(j.url); });
  var responses = withUrl.length ? UrlFetchApp.fetchAll(withUrl.map(function (j) {
    return { url: j.url, muteHttpExceptions: true, followRedirects: true };
  })) : [];
  return jobs.map(function (job) {
    var info = { photo: '', lat: '', lng: '', accuracy: '', result: 'ok' };
    var k = withUrl.indexOf(job);
    if (k >= 0) {
      var res = responses[k];
      var code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        var html = res.getContentText();
        var page = rightmoveInfo_(html) || {};
        info.photo = page.photo || shareImage_(html, job.url);
        if (isFinite(page.lat) && isFinite(page.lng) && page.lat !== '' && page.lng !== '') {
          info.lat = page.lat;
          info.lng = page.lng;
          info.accuracy = page.exact ? 'exact' : 'approximate';
        }
      } else {
        info.result = 'failed: HTTP ' + code;
      }
    } else if (job.url) {
      info.result = 'not a web link';
    }
    if (info.lat === '' && job.location) {
      var place = geocode_(job.location);
      if (place) { info.lat = place.lat; info.lng = place.lng; info.accuracy = 'approximate'; }
    }
    return info;
  });
}

function saveListingInfo_(jobs, infos) {
  var time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  withLock_(function () {
    jobs.forEach(function (job, i) {
      var found = locate_(job.id);
      if (!found || jobFor_(found).url !== job.url) return; // deleted, or link changed meanwhile
      var info = infos[i];
      found.sheet.getRange(found.row, PHOTO_COL, 1, LAST_COL - PHOTO_COL + 1).setValues([[
        cell_(null, info.photo), cell_(null, info.lat), cell_(null, info.lng),
        cell_(null, info.accuracy), cell_(null, time + ' ' + info.result),
      ]]);
    });
  });
}

// Rightmove: window.__PAGE_MODEL = {"data": "<JSON of one flat array>", ...}.
// Object values in that array are indexes into the same array; arr[0] is the
// root, whose propertyData has `images` (ordered; each with ready-made sizes)
// and `location` (latitude, longitude, pinType, circleRadiusOnMap).
function rightmoveInfo_(html) {
  try {
    var at = html.indexOf('window.__PAGE_MODEL');
    if (at < 0) return null;
    var start = html.indexOf('{', at);
    var end = matchingBrace_(html, start);
    if (end < 0) return null;
    var arr = JSON.parse(JSON.parse(html.slice(start, end + 1)).data);
    var ref = function (i) { return typeof i === 'number' && i >= 0 && i < arr.length ? arr[i] : undefined; };
    var property = ref(arr[0] && arr[0].propertyData);
    if (!property) return null;
    var first = ref((ref(property.images) || [])[0]);
    var sizes = first ? ref(first.resizedImageUrls) || {} : {};
    var location = ref(property.location) || {};
    return {
      photo: ref(sizes.size476x317) || (first && ref(first.url)) || '',
      lat: ref(location.latitude),
      lng: ref(location.longitude),
      exact: ref(location.pinType) === 'ACCURATE_POINT' && !ref(location.circleRadiusOnMap),
    };
  } catch (e) {
    return null;
  }
}

// Index of the brace that closes the one at `start`, skipping braces in strings.
function matchingBrace_(s, start) {
  var depth = 0;
  var inString = false;
  for (var i = start; i < s.length; i++) {
    var ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The image a page offers when its link is shared (og:image), as a full URL.
function shareImage_(html, pageUrl) {
  var tag = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i);
  var content = tag && tag[0].match(/content=["']([^"']+)["']/i);
  if (!content) return '';
  var src = content[1].replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(src)) return src;
  var origin = pageUrl.match(/^https?:\/\/[^\/]+/i);
  if (src.indexOf('//') === 0) return 'https:' + src;
  return origin && src[0] === '/' ? origin[0] + src : '';
}

function geocode_(place) {
  try {
    var res = Maps.newGeocoder().setRegion('uk').geocode(place + ', UK');
    var hit = res && res.status === 'OK' && res.results[0];
    return hit ? { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng } : null;
  } catch (e) {
    return null;
  }
}
