// House Hunt — a tiny static app. Data lives in a Google Sheet that only the
// Apps Script (apps-script/Code.gs) touches; with no API URL configured it
// runs in demo mode and keeps data in this browser.
//
// Written to run on older iPads (Safari 10.3+): no `?.`, `??`, <dialog>,
// object spread or optional catch bindings.

// Fields shown in the app. The sheet also keeps a distLudlow column (no longer
// shown); saves start from the stored house so its value is left alone.
var FIELDS = ['name', 'location', 'price', 'link', 'distShrewsbury',
  'shirley', 'martin', 'actions', 'agent'];
var SORTS = ['newest', 'sheet', 'priceAsc', 'priceDesc', 'shrewsbury'];

var API_URL = (window.MSH_API_URL || '').trim();
var DEMO = !API_URL;

var state = {
  houses: [],
  status: localGet('msh.tab') || 'possible',
  query: '',
  sort: SORTS.indexOf(localGet('msh.sort')) >= 0 ? localGet('msh.sort') : 'newest',
  editingId: null,
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

// ---------- storage ----------

function localGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function localSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { /* private mode etc. */ }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

var localStore = {
  load: function () {
    try { return JSON.parse(localGet('msh.houses') || '[]'); } catch (e) { return []; }
  },
  write: function (houses) { localSet('msh.houses', JSON.stringify(houses)); },
  list: function () { return Promise.resolve(this.load()); },
  save: function (house) {
    var houses = this.load();
    if (!house.id) house.id = newId();
    var i = indexOfId(houses, house.id);
    if (i >= 0) houses[i] = house; else houses.push(house);
    this.write(houses);
    return Promise.resolve(house);
  },
  remove: function (id) {
    this.write(this.load().filter(function (h) { return h.id !== id; }));
    return Promise.resolve();
  },
};

function AuthError(message) { this.message = message; }

// AbortController is too new for old iPads, so race the request against a timer instead.
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('the sheet took too long to answer')); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); });
  });
}

var remoteStore = {
  call: async function (payload) {
    payload.password = localGet('msh.password') || '';
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
    var res = await withTimeout(fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    }), 20000);
    var data = await res.json();
    if (data.auth) throw new AuthError(data.error);
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  list: async function () { return (await this.call({ action: 'list' })).houses; },
  save: async function (house) { return (await this.call({ action: 'save', house: house })).house; },
  remove: async function (id) { await this.call({ action: 'delete', id: id }); },
};

var store = DEMO ? localStore : remoteStore;

// ---------- helpers ----------

function indexOfId(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
  return -1;
}
function findHouse(id) { return state.houses[indexOfId(state.houses, id)]; }

function str(v) { return v === null || v === undefined ? '' : String(v); }

function esc(s) {
  return str(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(s) {
  var n = parseFloat(str(s).replace(/[£,\s]/g, '').replace(/k$/i, '000'));
  return isFinite(n) ? n : null;
}

function formatPrice(p) {
  var s = str(p).trim();
  if (/^[\d,.]+$/.test(s)) return '£' + Number(s.replace(/,/g, '')).toLocaleString('en-GB');
  return s;
}

function safeUrl(u) {
  var s = str(u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function mapsUrl(location) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(location + ', UK');
}

// Optional action, e.g. toast('Moved', 'Undo', fn), adds a button and stays up longer.
var toastTimer;
function toast(msg, actionLabel, onAction) {
  var el = $('#toast');
  el.innerHTML = '<span>' + esc(msg) +
    (actionLabel ? ' <button type="button">' + esc(actionLabel) + '</button>' : '') + '</span>';
  if (actionLabel) {
    el.querySelector('button').addEventListener('click', function () {
      el.hidden = true;
      onAction();
    });
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, actionLabel ? 6000 : 2500);
}

function setBanner(msg, isError) {
  var el = $('#banner');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function showPanel(id, show) {
  $(id).hidden = !show;
  document.body.classList.toggle('locked', !$('#editPanel').hidden || !$('#loginPanel').hidden);
}

// ---------- rendering ----------

function visibleHouses() {
  var q = state.query.trim().toLowerCase();
  var list = state.houses.filter(function (h) { return h.status === state.status; });
  if (q) {
    list = list.filter(function (h) {
      return FIELDS.some(function (f) { return str(h[f]).toLowerCase().indexOf(q) >= 0; });
    });
  }
  function by(key, dir) {
    return function (a, b) {
      var x = num(a[key]), y = num(b[key]);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x - y) * dir;
    };
  }
  if (state.sort === 'priceAsc') list.sort(by('price', 1));
  if (state.sort === 'priceDesc') list.sort(by('price', -1));
  if (state.sort === 'shrewsbury') list.sort(by('distShrewsbury', 1));
  // Rows are in sheet order, and new or moved houses go to the bottom of their tab.
  if (state.sort === 'newest') list.reverse();
  return list;
}

// The labelled note blocks on each card, in order. Only `rateable` ones get
// 👍/👎 buttons and turn green/red; the rest stay neutral grey.
var NOTES = [
  { key: 'shirley', label: 'Mum’s thoughts', add: 'Mum’s thoughts', rateable: true },
  { key: 'martin', label: 'Dad’s thoughts', add: 'Dad’s thoughts', rateable: true },
  { key: 'actions', label: 'Actions & decision', add: 'actions' },
  { key: 'agent', label: 'Estate agent', add: 'estate agent' },
];

function filled(v) { return str(v).trim() !== ''; }

// A dashed "+ Add …" placeholder; tapping it opens the form at that field.
function missing(field, label) {
  return '<button type="button" class="missing" data-fill="' + field + '">+ Add ' + label + '</button>';
}

// Ratings: {"shirley": "+", "martin": "-"}; a note with no rating is neutral.
function ratingsOf(h) {
  try { return JSON.parse(h.ratings || '{}') || {}; } catch (e) { return {}; }
}

function noteBlock(h, n) {
  var r = n.rateable ? ratingsOf(h)[n.key] : null;
  var mood = r === '+' ? 'pos' : r === '-' ? 'neg' : 'neutral';
  function rateBtn(value, icon, label) {
    return '<button type="button" class="rate' + (r === value ? ' on' : '') + '" data-rate="' + value +
      '" data-key="' + n.key + '" aria-label="' + label + '" aria-pressed="' + (r === value) + '">' + icon + '</button>';
  }
  return '<div class="field ' + mood + '">' +
    '<div class="field-head"><div class="field-label">' + esc(n.label) + '</div>' +
    (n.rateable ? '<div class="rates">' + rateBtn('+', '👍', 'Positive') + rateBtn('-', '👎', 'Negative') + '</div>' : '') +
    '</div>' +
    '<div class="field-text clip">' + esc(h[n.key]) + '</div></div>';
}

// The original sheet sometimes recorded only the nearest town, with no time.
// Treat that as not filled in, so it shows as "+ Add distance".
function tidy(h) {
  if (str(h.distShrewsbury).trim().toLowerCase() === 'nearest') h.distShrewsbury = '';
  return h;
}

var GROUPS = { possible: 'Possibilities', visited: 'Visited', rejected: 'Rejected' };

function moveButtons(h) {
  return Object.keys(GROUPS).filter(function (g) { return g !== h.status; }).map(function (g) {
    return '<button type="button" class="move-btn" data-move="' + g + '">→ ' + GROUPS[g] + '</button>';
  }).join('');
}

var TRACKED = ['price', 'location', 'distShrewsbury', 'link'].concat(NOTES.map(function (n) { return n.key; }));

function cardHtml(h) {
  var link = safeUrl(h.link);
  var todo = TRACKED.filter(function (f) { return !filled(h[f]); }).length;
  var emptyNotes = NOTES.filter(function (n) { return !filled(h[n.key]); });
  return '<article class="card" data-id="' + esc(h.id) + '" tabindex="0">' +
    '<div class="card-top">' +
      '<h3>' + (esc(h.name) || '<i>Unnamed</i>') + '</h3>' +
      (filled(h.price) ? '<span class="price">' + esc(formatPrice(h.price)) + '</span>'
        : missing('price', 'price')) +
    '</div>' +
    (todo ? '<div class="todo">' + todo + (todo === 1 ? ' detail' : ' details') + ' to fill in</div>' : '') +
    '<div class="facts">' +
      (filled(h.location) ? '<a class="fact" href="' + mapsUrl(h.location) +
        '" target="_blank" rel="noopener">📍 ' + esc(h.location) + '</a>' : missing('location', 'location')) +
      (filled(h.distShrewsbury) ? '<span class="fact">🚗 ' + esc(h.distShrewsbury) + ' to Shrewsbury</span>'
        : missing('distShrewsbury', 'distance')) +
    '</div>' +
    NOTES.filter(function (n) { return filled(h[n.key]); }).map(function (n) { return noteBlock(h, n); }).join('') +
    (emptyNotes.length ? '<div class="missing-row">' + emptyNotes.map(function (n) {
      return missing(n.key, n.add);
    }).join('') + '</div>' : '') +
    '<div class="card-actions">' +
      (link ? '<a class="listing" href="' + esc(link) + '" target="_blank" rel="noopener">Listing ↗</a>'
        : missing('link', 'link')) +
      moveButtons(h) +
    '</div>' +
    '</article>';
}

function render() {
  $$('.tabs button').forEach(function (b) {
    var active = b.getAttribute('data-status') === state.status;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active);
    b.querySelector('.count').textContent = state.houses.filter(function (h) {
      return h.status === b.getAttribute('data-status');
    }).length;
  });
  var list = visibleHouses();
  $('#list').innerHTML = list.length
    ? list.map(cardHtml).join('')
    : '<div class="empty">' + (state.query ? 'No matches.' : 'Nothing here yet.') + '</div>';
}

// ---------- data flow ----------

function handleError(err, prefix) {
  if (err instanceof AuthError) {
    localSet('msh.password', null);
    showLogin(err.message);
  } else {
    toast(prefix + ': ' + err.message);
  }
}

// mode: 'load' (page opened; spin), 'tap' (refresh button; spin + toast),
// 'background' (app came back into view; silent unless it fails).
var refreshing = false;
async function refresh(mode) {
  if (refreshing) return;
  refreshing = true;
  var btn = $('#refreshBtn');
  if (mode !== 'background') btn.classList.add('spinning');
  try {
    state.houses = (await store.list()).map(tidy);
    setBanner(DEMO ? 'Demo mode: houses are saved on this device only.' : '');
    render();
    if (mode === 'tap') toast('Up to date');
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setBanner('Couldn’t load the list (' + err.message + '). Check the internet connection and tap ⟳.', true);
  } finally {
    refreshing = false;
    btn.classList.remove('spinning');
  }
}

function showLogin(message) {
  var err = $('#loginError');
  err.hidden = !message;
  err.textContent = message || '';
  $('#loginForm').elements.password.value = '';
  showPanel('#loginPanel', true);
}

// focusField: jump straight to that input (used by the "+ Add …" placeholders).
function openEditor(house, focusField) {
  var form = $('#editForm');
  form.reset();
  state.editingId = house ? house.id : null;
  $('#editTitle').textContent = house ? 'Edit house' : 'New house';
  $('#deleteBtn').hidden = !house;
  form.elements.status.value = house ? house.status : state.status;
  FIELDS.forEach(function (f) { form.elements[f].value = house ? str(house[f]) : ''; });
  showPanel('#editPanel', true);
  form.querySelector('.panel-body').scrollTop = 0;
  // Focus inside the tap itself, or iOS won't bring up the keyboard.
  if (focusField && form.elements[focusField]) form.elements[focusField].focus();
}

var saving = false;
async function saveFromForm() {
  if (saving) return;
  var form = $('#editForm');
  // Start from the stored house so fields the form doesn't show (e.g. distLudlow) survive.
  var house = Object.assign({}, findHouse(state.editingId),
    { id: state.editingId, status: form.elements.status.value });
  FIELDS.forEach(function (f) { house[f] = form.elements[f].value.trim(); });
  if (!house.name) { toast('Please give the house a name'); return; }
  saving = true;
  toast('Saving…');
  try {
    var saved = await store.save(house);
    var i = indexOfId(state.houses, saved.id);
    if (i >= 0) state.houses[i] = saved; else state.houses.push(saved);
    state.status = saved.status;
    localSet('msh.tab', state.status);
    showPanel('#editPanel', false); // only close once it's safely stored
    render();
    toast('Saved');
  } catch (err) {
    handleError(err, 'Not saved');
  } finally {
    saving = false;
  }
}

async function deleteCurrent() {
  var h = findHouse(state.editingId);
  if (!h || !confirm('Delete "' + h.name + '"? This can’t be undone.')) return;
  try {
    await store.remove(h.id);
    state.houses = state.houses.filter(function (x) { return x.id !== h.id; });
    showPanel('#editPanel', false);
    render();
    toast('Deleted');
  } catch (err) {
    handleError(err, 'Not deleted');
  }
}

// One-tap changes (moves, ratings) show on screen straight away; if the save
// fails the house is put back. Saves are queued so they reach the sheet in
// order, e.g. a quick Undo can't arrive before the move it undoes.
var quickQueue = Promise.resolve();
function quickChange(id, changes, failPrefix) {
  var h = findHouse(id);
  if (!h) return;
  var updated = Object.assign({}, h, changes);
  state.houses[indexOfId(state.houses, id)] = updated;
  render();
  quickQueue = quickQueue.then(function () { return store.save(updated); }).catch(function (err) {
    var i = indexOfId(state.houses, id);
    if (i >= 0) state.houses[i] = h;
    render();
    handleError(err, failPrefix);
  });
}

function moveHouse(id, status, isUndo) {
  var h = findHouse(id);
  if (!h || h.status === status) return;
  var from = h.status;
  quickChange(id, { status: status }, 'Not moved');
  if (isUndo) toast('Moved back to ' + GROUPS[status]);
  else toast('Moved to ' + GROUPS[status], 'Undo', function () { moveHouse(id, from, true); });
}

// Tapping the active rating again clears it back to neutral.
function rateNote(id, key, value) {
  var ratings = ratingsOf(findHouse(id));
  if (ratings[key] === value) delete ratings[key]; else ratings[key] = value;
  quickChange(id, { ratings: Object.keys(ratings).length ? JSON.stringify(ratings) : '' }, 'Rating not saved');
}

// ---------- wiring ----------

$$('.tabs button').forEach(function (b) {
  b.addEventListener('click', function () {
    state.status = b.getAttribute('data-status');
    localSet('msh.tab', state.status);
    render();
  });
});

$('#search').addEventListener('input', function (e) { state.query = e.target.value; render(); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', function (e) {
  state.sort = e.target.value;
  localSet('msh.sort', state.sort);
  render();
});

$('#list').addEventListener('click', function (e) {
  if (e.target.closest('a')) return; // let links open normally
  var card = e.target.closest('.card');
  if (!card) return;
  var move = e.target.closest('[data-move]');
  var fill = e.target.closest('[data-fill]');
  var rate = e.target.closest('[data-rate]');
  if (move) moveHouse(card.getAttribute('data-id'), move.getAttribute('data-move'));
  else if (rate) rateNote(card.getAttribute('data-id'), rate.getAttribute('data-key'), rate.getAttribute('data-rate'));
  else openEditor(findHouse(card.getAttribute('data-id')), fill && fill.getAttribute('data-fill'));
});

$('#addBtn').addEventListener('click', function () { openEditor(null); });
$('#refreshBtn').addEventListener('click', function () { refresh('tap'); });
$('#editForm').addEventListener('submit', function (e) { e.preventDefault(); saveFromForm(); });
$('#deleteBtn').addEventListener('click', deleteCurrent);
$$('[data-close]').forEach(function (b) {
  b.addEventListener('click', function () { showPanel('#editPanel', false); });
});

$('#loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  localSet('msh.password', e.target.elements.password.value);
  showPanel('#loginPanel', false);
  refresh('load');
});

$('#logoutBtn').hidden = DEMO;
$('#logoutBtn').addEventListener('click', function () {
  localSet('msh.password', null);
  state.houses = [];
  render();
  showLogin();
});

// Pick up changes made on another device when the app comes back into view.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  checkForUpdate();
  if (!DEMO && localGet('msh.password')) refresh('background');
});

// ---------- updates ----------
// The deploy workflow stamps every release's version into this file, index.html
// (as ?v= on each asset) and version.json. If version.json has moved on, this
// copy of the app is stale, so load the page again under a fresh URL, which
// gets past the 10-minute cache GitHub Pages asks browsers to use.

var APP_VERSION = '__VERSION__';

async function checkForUpdate() {
  if (APP_VERSION.indexOf('__') === 0) return; // running locally, not deployed
  if (!$('#editPanel').hidden || saving) return; // don't throw away someone's typing
  try {
    var res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    var latest = (await res.json()).version;
    if (!latest || latest === APP_VERSION) return;
    // Guard against a reload loop if the new page is somehow still the old one.
    if (sessionStorageGet('msh.reloadedFor') === latest) return;
    sessionStorageSet('msh.reloadedFor', latest);
    location.replace(location.pathname + '?v=' + latest);
  } catch (e) { /* offline: try again next time */ }
}

function sessionStorageGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function sessionStorageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

render();
if (!DEMO && !localGet('msh.password')) showLogin();
else refresh('load');
checkForUpdate();
