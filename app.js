// House Hunt — a tiny static app. Data lives in a Google Sheet that only the
// Apps Script (apps-script/Code.gs) touches; with no API URL configured it
// runs in demo mode and keeps data in this browser.
//
// Written to run on older iPads (Safari 10.3+): no `?.`, `??`, <dialog>,
// object spread or optional catch bindings.

var FIELDS = ['name', 'location', 'price', 'link', 'distShrewsbury', 'distLudlow',
  'shirley', 'martin', 'actions', 'agent'];

var API_URL = (window.MSH_API_URL || '').trim();
var DEMO = !API_URL;

var state = {
  houses: [],
  status: localGet('msh.tab') || 'possible',
  query: '',
  sort: localGet('msh.sort') || 'sheet',
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

var remoteStore = {
  call: async function (payload) {
    payload.password = localGet('msh.password') || '';
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
    var res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
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

var toastTimer;
function toast(msg) {
  var el = $('#toast');
  el.innerHTML = '<span>' + esc(msg) + '</span>';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2500);
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
  if (state.sort === 'ludlow') list.sort(by('distLudlow', 1));
  return list;
}

function note(label, text) {
  if (!str(text).trim()) return '';
  return '<p class="note clip"><b>' + label + ':</b> ' + esc(text) + '</p>';
}

function cardHtml(h) {
  var link = safeUrl(h.link);
  var chips = '';
  if (h.distShrewsbury) chips += '<span class="chip">Shrewsbury ' + esc(h.distShrewsbury) + '</span>';
  if (h.distLudlow) chips += '<span class="chip">Ludlow ' + esc(h.distLudlow) + '</span>';
  return '<article class="card" data-id="' + esc(h.id) + '" tabindex="0">' +
    '<div class="card-top"><h3>' + (esc(h.name) || '<i>Unnamed</i>') + '</h3>' +
    '<span class="price">' + esc(formatPrice(h.price)) + '</span></div>' +
    (h.location ? '<div class="loc">📍 <a href="' + mapsUrl(h.location) +
      '" target="_blank" rel="noopener">' + esc(h.location) + '</a></div>' : '') +
    (chips ? '<div class="chips">' + chips + '</div>' : '') +
    note('Shirley', h.shirley) +
    note('Martin', h.martin) +
    note('Actions', h.actions) +
    (link ? '<div class="card-actions"><a href="' + esc(link) +
      '" target="_blank" rel="noopener">View listing ↗</a></div>' : '') +
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

async function refresh(quiet) {
  var btn = $('#refreshBtn');
  btn.classList.add('spinning');
  try {
    state.houses = await store.list();
    setBanner(DEMO ? 'Demo mode: houses are saved on this device only.' : '');
    render();
    if (!quiet) toast('Up to date');
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setBanner('Couldn’t load the list (' + err.message + '). Check the internet connection and tap ⟳.', true);
  } finally {
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

function openEditor(house) {
  var form = $('#editForm');
  form.reset();
  state.editingId = house ? house.id : null;
  $('#editTitle').textContent = house ? 'Edit house' : 'New house';
  $('#deleteBtn').hidden = !house;
  form.elements.status.value = house ? house.status : state.status;
  FIELDS.forEach(function (f) { form.elements[f].value = house ? str(house[f]) : ''; });
  showPanel('#editPanel', true);
  form.querySelector('.panel-body').scrollTop = 0;
}

var saving = false;
async function saveFromForm() {
  if (saving) return;
  var form = $('#editForm');
  var house = { id: state.editingId, status: form.elements.status.value };
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
  if (card) openEditor(findHouse(card.getAttribute('data-id')));
});

$('#addBtn').addEventListener('click', function () { openEditor(null); });
$('#refreshBtn').addEventListener('click', function () { refresh(false); });
$('#editForm').addEventListener('submit', function (e) { e.preventDefault(); saveFromForm(); });
$('#deleteBtn').addEventListener('click', deleteCurrent);
$$('[data-close]').forEach(function (b) {
  b.addEventListener('click', function () { showPanel('#editPanel', false); });
});

$('#loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  localSet('msh.password', e.target.elements.password.value);
  showPanel('#loginPanel', false);
  refresh(true);
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
  if (document.visibilityState === 'visible' && !DEMO && localGet('msh.password')) refresh(true);
});

render();
if (!DEMO && !localGet('msh.password')) showLogin();
else refresh(true);
