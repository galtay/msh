// A small in-memory stand-in for the Google Apps Script services Code.gs uses,
// so the real backend can run under Node. Each call runs Code.gs in a fresh
// context (like each Apps Script request) against the same spreadsheet.
//
// Writes are interpreted the way Sheets interprets typed input, because that's
// where the real bugs hide: "01743…" becomes a number (leading zero lost),
// "10/14" becomes a date, "=…"/"+…" become (broken) formulas, and a leading
// apostrophe keeps text exactly as typed.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const script = new vm.Script(CODE, { filename: 'Code.gs' });

function parseInput(x) {
  if (x === null || x === undefined || x === '') return { v: '' };
  if (typeof x !== 'string') return { v: x };
  if (x[0] === "'") return { v: x.slice(1) };
  if (x[0] === '=' || (x[0] === '+' && !/^\+\d+(\.\d+)?$/.test(x))) return { v: '#ERROR!', formula: x };
  if (/^[+-]?\d+(\.\d+)?$/.test(x)) return { v: Number(x) };
  const money = x.match(/^£\s*([\d,]+(\.\d+)?)$/);
  if (money) return { v: Number(money[1].replace(/,/g, '')), fmt: '£' };
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(x)) return { v: new Date(2026, 0, 1), date: x };
  return { v: x };
}

function display(cell) {
  if (!cell) return '';
  if (cell.date) return '01/01/2026';
  if (typeof cell.v === 'number') return cell.fmt === '£' ? '£' + cell.v.toLocaleString('en-GB') : String(cell.v);
  return String(cell.v);
}

class MockRange {
  constructor(sheet, row, col, nRows, nCols) {
    Object.assign(this, { sheet, row, col, nRows, nCols });
  }
  _map(fn) {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const line = [];
      for (let c = 0; c < this.nCols; c++) line.push(fn(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getRow() { return this.row; }
  getValues() { return this._map((r, c) => { const x = this.sheet._cell(r, c); return x ? x.v : ''; }); }
  getDisplayValues() { return this._map((r, c) => display(this.sheet._cell(r, c))); }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  getRichTextValues() {
    return this._map((r, c) => {
      const url = this.sheet.links[`${r},${c}`] || null;
      return { getLinkUrl: () => url, getText: () => display(this.sheet._cell(r, c)) };
    });
  }
  getRichTextValue() { return this.getRichTextValues()[0][0]; }
  getCell(r, c) { return new MockRange(this.sheet, this.row + r - 1, this.col + c - 1, 1, 1); }
  setValues(values) {
    if (values.length !== this.nRows || values.some((l) => l.length !== this.nCols)) {
      throw new Error('setValues: data does not match the range size');
    }
    values.forEach((line, r) => line.forEach((x, c) => this.sheet._set(this.row + r, this.col + c, x)));
    return this;
  }
  setValue(x) { return this.setValues([[x]]); }
  setNumberFormat(f) {
    this._map((r, c) => {
      const cell = this.sheet._cell(r, c) || this.sheet._set(r, c, '');
      cell.fmt = f.indexOf('£') >= 0 ? '£' : undefined;
    });
    return this;
  }
}

class MockSheet {
  constructor(name, id, { rows = [], maxCols = 26 } = {}) {
    this.name = name;
    this.id = id;
    this.maxCols = maxCols;
    this.rows = []; // rows[r-1][c-1] = cell
    this.links = {}; // "r,c" -> url, like a rich-text hyperlink
    this.hidden = false;
    rows.forEach((line) => this.appendRow(line));
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if ((this.rows[r - 1] || []).some((x) => x && x.v !== '')) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach((line) => (line || []).forEach((x, c) => { if (x && x.v !== '') last = Math.max(last, c + 1); }));
    return last;
  }
  getRange(row, col, nRows = 1, nCols = 1) {
    if (row < 1 || col < 1 || nRows < 1 || nCols < 1) throw new Error('getRange: bad coordinates');
    if (col + nCols - 1 > this.maxCols) throw new Error('Range is out of bounds (sheet has ' + this.maxCols + ' columns)');
    return new MockRange(this, row, col, nRows, nCols);
  }
  appendRow(values) {
    const at = this.getLastRow() + 1;
    if (values.length > this.maxCols) this.maxCols = values.length;
    values.forEach((x, c) => this._set(at, c + 1, x));
  }
  deleteRow(r) { this.deleteRows(r, 1); }
  deleteRows(start, n) {
    if (start < 1) throw new Error('deleteRows: bad row');
    this.rows.splice(start - 1, n);
    this._shiftLinks(start, -n);
  }
  insertRowBefore(r) {
    this.rows.splice(r - 1, 0, []);
    this._shiftLinks(r, 1);
  }
  hideSheet() { this.hidden = true; }
  _cell(r, c) { return (this.rows[r - 1] || [])[c - 1]; }
  _set(r, c, x) {
    while (this.rows.length < r) this.rows.push([]);
    const old = this.rows[r - 1][c - 1];
    const cell = parseInput(x);
    // Like Sheets, a number written into a formatted cell keeps the cell's format.
    if (old && old.fmt && typeof cell.v === 'number' && !cell.fmt) cell.fmt = old.fmt;
    this.rows[r - 1][c - 1] = cell;
    delete this.links[`${r},${c}`];
    return cell;
  }
  _shiftLinks(from, by) {
    const next = {};
    Object.keys(this.links).forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      if (by < 0 && r >= from && r < from - by) return; // deleted
      next[`${r >= from ? r + by : r},${c}`] = this.links[k];
    });
    this.links = next;
  }
  // Test helpers: what a person looking at the sheet would see.
  displayRows() {
    const n = this.getLastRow();
    return n ? this.getRange(1, 1, n, this.maxCols).getDisplayValues() : [];
  }
}

class MockSpreadsheet {
  constructor() { this.sheets = []; this.nextId = 1; }
  addSheet(name, opts) {
    const s = new MockSheet(name, this.nextId++, opts);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) { return this.addSheet(name); }
}

// What the web looks like to the script: `pages` maps a URL to {code, body}
// (anything else is a 404); `places` maps a Location to {lat, lng}.
function makeWeb() {
  const web = { pages: {}, places: {}, fetched: [] };
  const respond = (url) => {
    web.fetched.push(url);
    const page = web.pages[url] || { code: 404, body: 'Not found' };
    if (page.throws) throw new Error(page.throws);
    return { getResponseCode: () => page.code, getContentText: () => page.body };
  };
  web.UrlFetchApp = {
    fetch: (url) => respond(url),
    fetchAll: (requests) => requests.map((r) => respond(r.url)),
  };
  web.Maps = {
    newGeocoder: () => ({
      setRegion() { return this; },
      geocode(address) {
        const hit = web.places[address.replace(/, UK$/, '')];
        return hit ? { status: 'OK', results: [{ geometry: { location: hit } }] } : { status: 'ZERO_RESULTS', results: [] };
      },
    }),
  };
  return web;
}

function makeServices(ss, { password, triggers, alerts, web }) {
  const ui = {
    createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }),
    alert: (...args) => { alerts.push(args[0]); return 'OK'; },
    ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL' },
  };
  return {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ui,
      getActiveSheet: () => ss.getSheetByName('Backups') || ss.sheets[0],
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'PASSWORD' ? password : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s).digest()),
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' '),
    },
    Session: { getScriptTimeZone: () => 'Europe/London' },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }),
    },
    UrlFetchApp: web.UrlFetchApp,
    Maps: web.Maps,
    console: { error() {}, log() {} },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((name) => ({ getHandlerFunction: () => name })),
      newTrigger: (name) => ({ timeBased: () => ({ everyHours: () => ({ create: () => triggers.push(name) }) }) }),
    },
  };
}

// The backend: `post(body)` is what the web app receives; `run(fn, ...args)`
// calls any other function in Code.gs (backups, menu items).
function makeBackend({ password = 'secret' } = {}) {
  const ss = new MockSpreadsheet();
  const triggers = [];
  const alerts = [];
  const web = makeWeb();
  function context() {
    const ctx = vm.createContext(makeServices(ss, { password, triggers, alerts, web }));
    script.runInContext(ctx);
    return ctx;
  }
  return {
    ss,
    triggers,
    alerts,
    web,
    post(body) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return JSON.parse(context().doPost({ postData: { contents: text } }).getContent());
    },
    get() { return context().doGet().getContent(); },
    run(fn, ...args) { return context()[fn](...args); },
  };
}

module.exports = { makeBackend, parseInput, display };
