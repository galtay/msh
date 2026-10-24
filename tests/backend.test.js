// Tests for apps-script/Code.gs, run against the in-memory sheet in sheet-mock.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBackend } = require('./sheet-mock');
const { seed } = require('./fixtures');

const PW = 'secret';
const setup = (opts) => seed(makeBackend({ password: PW }), opts);
const call = (b, body) => b.post(Object.assign({ password: PW }, body));
const list = (b) => call(b, { action: 'list' });
const byId = (b, id) => list(b).houses.find((h) => h.id === id);
const tab = (b, name) => b.ss.getSheetByName(name);

test('rejects a wrong or missing password without returning data', () => {
  const b = setup();
  for (const password of ['nope', undefined, '']) {
    const res = b.post({ action: 'list', password });
    assert.deepEqual(res, { ok: false, auth: true, error: 'Wrong password' });
  }
});

test('GET reports the script version', () => {
  assert.match(makeBackend().get(), /^House Hunt API version 4 is running\.$/);
});

test('bad requests come back as errors, not crashes', () => {
  const b = setup();
  assert.equal(b.post('not json').ok, false);
  assert.match(call(b, { action: 'explode' }).error, /^Unknown action/);
  assert.match(call(b, { action: 'update', id: 'missing', changes: {} }).error, /no longer in the sheet/);
  assert.match(call(b, { action: 'update', id: 'p1', changes: { status: 'sold' } }).error, /Unknown group/);
  assert.match(call(b, { action: 'create', house: { name: 'X', status: 'sold' } }).error, /Unknown group/);
});

test('list returns every house with its group, version and display values', () => {
  const res = list(setup());
  assert.equal(res.ok, true);
  assert.equal(res.version, 4);
  assert.deepEqual(res.houses.map((h) => `${h.id}:${h.status}`),
    ['p1:possible', 'p2:possible', 'p3:possible', 'v1:visited', 'r1:rejected']);
  const p1 = res.houses[0];
  assert.equal(p1.price, '£450,000');
  assert.equal(p1.shirley, 'Lovely garden');
  assert.equal(p1.ratings, '');
});

test('list adds the Ratings column and header to tabs from before it existed', () => {
  const b = setup({ columns: 11 });
  list(b);
  for (const name of ['House Possibilities', 'Visited', 'Rejected No Visit']) {
    const header = tab(b, name).displayRows()[0];
    assert.equal(header[10], 'ID');
    assert.equal(header[11], 'Ratings');
  }
});

test('list gives IDs to rows that lack one and keeps them stable', () => {
  const b = setup();
  tab(b, 'Visited').appendRow(['Added By Hand', 'Somewhere']);
  const first = list(b).houses.find((h) => h.name === 'Added By Hand');
  assert.ok(first.id);
  assert.equal(list(b).houses.find((h) => h.name === 'Added By Hand').id, first.id);
});

test('list skips blank rows', () => {
  const b = setup();
  tab(b, 'Visited').appendRow(['', '', '', '', '', '', '', '', '', '', '']);
  tab(b, 'Visited').appendRow(['After A Gap']);
  const names = list(b).houses.filter((h) => h.status === 'visited').map((h) => h.name);
  assert.deepEqual(names, ['Hilltop View', 'After A Gap']);
});

test('list returns the real URL of a rich-text link', () => {
  const b = setup();
  const sheet = tab(b, 'Visited');
  sheet.getRange(2, 4).setValue('Rightmove');
  sheet.links['2,4'] = 'https://example.com/real-link';
  assert.equal(byId(b, 'v1').link, 'https://example.com/real-link');
});

test('create adds a house to the bottom of its tab with a new ID', () => {
  const b = setup();
  const res = call(b, { action: 'create', house: { name: 'New Place', status: 'visited', price: '480000' } });
  assert.equal(res.ok, true);
  assert.ok(res.house.id);
  assert.equal(res.house.status, 'visited');
  const visited = list(b).houses.filter((h) => h.status === 'visited');
  assert.equal(visited[visited.length - 1].name, 'New Place');
});

test('text is stored exactly as typed (no formulas, dates or lost zeros)', () => {
  const b = setup();
  const tricky = {
    name: '=HYPERLINK("http://evil")',
    location: '01743',
    agent: '+44 1743 000000',
    actions: '10/14',
    shirley: '-not a number',
    martin: '@mention',
  };
  const res = call(b, { action: 'create', house: Object.assign({ status: 'possible' }, tricky) });
  for (const [k, v] of Object.entries(tricky)) assert.equal(res.house[k], v, k);
  const again = byId(b, res.house.id);
  for (const [k, v] of Object.entries(tricky)) assert.equal(again[k], v, k);
});

test('prices typed as amounts stay numbers; anything else is kept as text', () => {
  const b = setup();
  const a = call(b, { action: 'create', house: { name: 'A', price: '£475,000' } }).house;
  const c = call(b, { action: 'create', house: { name: 'C', price: 'offers over 400k' } }).house;
  assert.equal(a.price, '£475,000');
  assert.equal(c.price, 'offers over 400k');
});

test('update changes only the fields it is given', () => {
  const b = setup();
  const before = byId(b, 'p2');
  const res = call(b, { action: 'update', id: 'p2', changes: { shirley: 'Nice views' } });
  assert.equal(res.ok, true);
  const after = byId(b, 'p2');
  assert.equal(after.shirley, 'Nice views');
  for (const k of ['name', 'location', 'price', 'link', 'martin', 'actions', 'agent', 'distLudlow']) {
    assert.equal(after[k], before[k], k);
  }
});

test('updates from two devices to different fields both survive', () => {
  const b = setup();
  call(b, { action: 'update', id: 'p1', changes: { martin: 'Dad edit' } });
  call(b, { action: 'update', id: 'p1', changes: { ratings: { shirley: '+' } } });
  call(b, { action: 'update', id: 'p1', changes: { actions: 'Booked viewing' } });
  const p1 = byId(b, 'p1');
  assert.equal(p1.martin, 'Dad edit');
  assert.equal(p1.actions, 'Booked viewing');
  assert.deepEqual(JSON.parse(p1.ratings), { shirley: '+' });
});

test('untouched cells keep their values through an update (leading zeros, prices)', () => {
  const b = setup();
  call(b, { action: 'update', id: 'p1', changes: { agent: '01743 000000' } });
  call(b, { action: 'update', id: 'p1', changes: { location: '01234' } });
  call(b, { action: 'update', id: 'p1', changes: { shirley: 'again' } });
  const p1 = byId(b, 'p1');
  assert.equal(p1.agent, '01743 000000');
  assert.equal(p1.location, '01234');
  assert.equal(p1.price, '£450,000');
});

test('ratings merge per note, and null clears one', () => {
  const b = setup();
  call(b, { action: 'update', id: 'v1', changes: { ratings: { shirley: '+' } } });
  call(b, { action: 'update', id: 'v1', changes: { ratings: { martin: '-' } } });
  assert.deepEqual(JSON.parse(byId(b, 'v1').ratings), { shirley: '+', martin: '-' });
  call(b, { action: 'update', id: 'v1', changes: { ratings: { shirley: null } } });
  assert.deepEqual(JSON.parse(byId(b, 'v1').ratings), { martin: '-' });
  call(b, { action: 'update', id: 'v1', changes: { ratings: { martin: null } } });
  assert.equal(byId(b, 'v1').ratings, '');
});

test('ratings ignore unknown notes and values', () => {
  const b = setup();
  call(b, { action: 'update', id: 'v1', changes: { ratings: { shirley: 'yes', nobody: '+', martin: '-' } } });
  assert.deepEqual(JSON.parse(byId(b, 'v1').ratings), { martin: '-' });
});

test('moving a house carries every field, including ratings and hidden columns', () => {
  const b = setup();
  call(b, { action: 'update', id: 'r1', changes: { ratings: { martin: '+' } } });
  const before = byId(b, 'r1');
  const res = call(b, { action: 'update', id: 'r1', changes: { status: 'visited' } });
  assert.equal(res.house.status, 'visited');
  const after = byId(b, 'r1');
  assert.equal(after.status, 'visited');
  for (const k of ['name', 'price', 'link', 'shirley', 'martin', 'distLudlow', 'ratings']) {
    assert.equal(after[k], before[k], k);
  }
  assert.equal(list(b).houses.filter((h) => h.id === 'r1').length, 1);
  const visited = list(b).houses.filter((h) => h.status === 'visited');
  assert.equal(visited[visited.length - 1].id, 'r1', 'moved houses go to the bottom');
});

test('moving keeps the real URL of a rich-text link', () => {
  const b = setup();
  const sheet = tab(b, 'Visited');
  sheet.getRange(2, 4).setValue('Rightmove');
  sheet.links['2,4'] = 'https://example.com/real-link';
  call(b, { action: 'update', id: 'v1', changes: { status: 'rejected' } });
  assert.equal(byId(b, 'v1').link, 'https://example.com/real-link');
});

test('move and move back (Undo) leaves one copy in the original tab', () => {
  const b = setup();
  call(b, { action: 'update', id: 'p1', changes: { status: 'rejected' } });
  call(b, { action: 'update', id: 'p1', changes: { status: 'possible' } });
  const all = list(b).houses.filter((h) => h.id === 'p1');
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'possible');
});

test('the legacy whole-house save still works for not-yet-updated apps', () => {
  const b = setup();
  const h = byId(b, 'p2');
  const res = call(b, { action: 'save', house: Object.assign({}, h, { martin: 'Legacy edit', ratings: '{"shirley":"-"}' }) });
  assert.equal(res.ok, true);
  const after = byId(b, 'p2');
  assert.equal(after.martin, 'Legacy edit');
  assert.deepEqual(JSON.parse(after.ratings), { shirley: '-' });
  const created = call(b, { action: 'save', house: { name: 'Legacy New', status: 'possible' } });
  assert.ok(created.house.id);
});

test('delete removes the house; deleting again is harmless', () => {
  const b = setup();
  assert.equal(call(b, { action: 'delete', id: 'p2' }).ok, true);
  assert.equal(byId(b, 'p2'), undefined);
  assert.equal(call(b, { action: 'delete', id: 'p2' }).ok, true);
  assert.equal(list(b).houses.length, 4);
});

test('very long text is capped', () => {
  const b = setup();
  const res = call(b, { action: 'update', id: 'p1', changes: { actions: 'x'.repeat(20000) } });
  assert.equal(res.house.actions.length, 10000);
});

test('creates missing house tabs with headers', () => {
  const b = makeBackend({ password: PW });
  assert.deepEqual(list(b).houses, []);
  assert.deepEqual(b.ss.getSheets().map((s) => s.getName()),
    ['house possibilities', 'visited', 'rejected no visit']);
  assert.equal(b.ss.getSheets()[0].displayRows()[0][11], 'Ratings');
});

// ---------- backups ----------

test('a backup snapshots every tab into the hidden Backups tab', () => {
  const b = setup();
  b.run('backupNow');
  const backups = tab(b, 'Backups');
  assert.ok(backups.hidden);
  const rows = backups.displayRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], '5'); // houses
  assert.match(b.alerts[0], /^Backed up 5 houses/);
});

test('hourly backups skip unchanged data, then pick up changes', () => {
  const b = setup();
  b.run('hourlyBackup');
  b.run('hourlyBackup');
  assert.equal(tab(b, 'Backups').getLastRow(), 2);
  call(b, { action: 'update', id: 'p1', changes: { shirley: 'changed' } });
  b.run('hourlyBackup');
  assert.equal(tab(b, 'Backups').getLastRow(), 3);
});

test('restoring a backup brings back the data, and backs up first', () => {
  const b = setup();
  call(b, { action: 'update', id: 'p1', changes: { ratings: { shirley: '+' }, agent: '01743 000000' } });
  b.run('backupNow');
  const good = list(b).houses;

  call(b, { action: 'delete', id: 'p2' });
  call(b, { action: 'update', id: 'p1', changes: { shirley: 'oops', status: 'rejected' } });
  call(b, { action: 'create', house: { name: 'Stray' } });

  // Backups are newest first: row 2 is the one taken above.
  const result = b.run('restoreBackupRow_', 2);
  assert.equal(result.count, 5);
  assert.deepEqual(list(b).houses, good);
  assert.equal(tab(b, 'Backups').getLastRow(), 3, 'the pre-restore state was backed up too');

  // ...so the restore can be undone.
  b.run('restoreBackupRow_', 2);
  assert.ok(list(b).houses.some((h) => h.name === 'Stray'));
});

test('large snapshots are split across cells and still restore', () => {
  const b = setup();
  const long = 'Lots of notes. '.repeat(600); // ~9,000 chars each
  for (let i = 0; i < 12; i++) call(b, { action: 'create', house: { name: `Big ${i}`, actions: long } });
  b.run('backupNow');
  const row = tab(b, 'Backups').getRange(2, 1, 1, 10).getValues()[0];
  assert.ok(row[4] !== '', 'snapshot continues into a second cell');
  const before = list(b).houses;
  call(b, { action: 'delete', id: 'p1' });
  b.run('restoreBackupRow_', 2);
  assert.deepEqual(list(b).houses, before);
});

test('only a week of backups is kept', () => {
  const b = setup();
  for (let i = 0; i < 24 * 7 + 5; i++) b.run('backupNow');
  assert.equal(tab(b, 'Backups').getLastRow() - 1, 24 * 7);
});

test('turning on hourly backups adds one trigger, once', () => {
  const b = setup();
  b.run('turnOnHourlyBackups');
  b.run('turnOnHourlyBackups');
  assert.deepEqual(b.triggers, ['hourlyBackup']);
});

// ---------- listing photos and locations ----------

const { rightmovePage, photoUrl } = require('./rightmove-page');
const RM = 'https://www.rightmove.co.uk/properties/123456#/?channel=RES_BUY';

function withListing(b, id, url, page) {
  call(b, { action: 'update', id, changes: { link: url } });
  if (page) b.web.pages[url] = page;
}

test('list includes the new columns, and older tabs get their headers', () => {
  const b = setup({ columns: 12 });
  const h = list(b).houses[0];
  for (const k of ['photo', 'lat', 'lng', 'accuracy', 'checked']) assert.equal(h[k], '', k);
  const header = tab(b, 'Visited').displayRows()[0];
  assert.deepEqual(header.slice(10, 17), ['ID', 'Ratings', 'Photo', 'Latitude', 'Longitude', 'Location accuracy', 'Listing checked']);
});

test('reads the main photo and exact position from a Rightmove listing', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 200, body: rightmovePage({ lat: 52.559692, lng: -2.475935 }) });
  const res = call(b, { action: 'enrich', id: 'p1' });
  assert.equal(res.ok, true);
  assert.equal(res.house.photo, photoUrl());
  assert.equal(res.house.lat, '52.559692');
  assert.equal(res.house.lng, '-2.475935');
  assert.equal(res.house.accuracy, 'exact');
  assert.match(res.house.checked, /^\d{4}-\d\d-\d\d \d\d:\d\d ok$/);
  assert.deepEqual(byId(b, 'p1').photo, photoUrl());
});

test('a Rightmove pin drawn as a circle counts as approximate', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 200, body: rightmovePage({ pinType: 'APPROXIMATE', radius: 500 }) });
  assert.equal(call(b, { action: 'enrich', id: 'p1' }).house.accuracy, 'approximate');
});

test('other sites: uses the page’s sharing image, and looks up the location', () => {
  const b = setup();
  const url = 'https://agent.example/listing/9';
  b.web.places['Testville'] = { lat: 52.1, lng: -2.9 };
  withListing(b, 'p1', url, { code: 200, body: '<meta property="og:image" content="/img/front.jpg?a=1&amp;b=2">' });
  const h = call(b, { action: 'enrich', id: 'p1' }).house;
  assert.equal(h.photo, 'https://agent.example/img/front.jpg?a=1&b=2');
  assert.equal(h.lat, '52.1');
  assert.equal(h.accuracy, 'approximate');
});

test('a blocked or missing page is recorded, and the location still looked up', () => {
  const b = setup();
  b.web.places['Testville'] = { lat: 52.1, lng: -2.9 };
  withListing(b, 'p1', RM, { code: 403, body: 'Forbidden' });
  const h = call(b, { action: 'enrich', id: 'p1' }).house;
  assert.equal(h.photo, '');
  assert.match(h.checked, / failed: HTTP 403$/);
  assert.equal(h.lat, '52.1');
});

test('unreadable pages never crash the script', () => {
  const b = setup();
  for (const body of ['', 'window.__PAGE_MODEL = {', 'window.__PAGE_MODEL = {"data":"not json"};',
    'window.__PAGE_MODEL = {"data":"[1,2,3]"};', '<html>' + 'x'.repeat(50000)]) {
    withListing(b, 'p1', RM + '&v=' + body.length, { code: 200, body });
    const res = call(b, { action: 'enrich', id: 'p1' });
    assert.equal(res.ok, true);
    assert.equal(res.house.photo, '');
  }
  b.web.pages[RM] = { throws: 'DNS error' };
  call(b, { action: 'update', id: 'p1', changes: { link: RM } });
  assert.equal(call(b, { action: 'enrich', id: 'p1' }).ok, false);
});

test('changing the link forgets what was read from the old listing', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 200, body: rightmovePage() });
  call(b, { action: 'enrich', id: 'p1' });
  call(b, { action: 'update', id: 'p1', changes: { shirley: 'note' } });
  assert.equal(byId(b, 'p1').photo, photoUrl(), 'other edits keep it');
  call(b, { action: 'update', id: 'p1', changes: { link: 'https://example.com/other' } });
  const h = byId(b, 'p1');
  for (const k of ['photo', 'lat', 'lng', 'accuracy', 'checked']) assert.equal(h[k], '', k);
});

test('moving a house keeps its photo and position', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 200, body: rightmovePage() });
  call(b, { action: 'enrich', id: 'p1' });
  call(b, { action: 'update', id: 'p1', changes: { status: 'visited' } });
  const h = byId(b, 'p1');
  assert.equal(h.photo, photoUrl());
  assert.equal(h.accuracy, 'exact');
  assert.match(h.checked, / ok$/, 'the time text stays text');
});

test('the hourly run fills in houses in batches, and doesn’t retry failures straight away', () => {
  const b = setup();
  for (let i = 0; i < 25; i++) {
    const url = `https://www.rightmove.co.uk/properties/${1000 + i}`;
    call(b, { action: 'create', house: { name: `House ${i}`, link: url } });
    b.web.pages[url] = { code: 200, body: rightmovePage({ id: 1000 + i }) };
  }
  b.run('hourlyBackup');
  const first = list(b).houses.filter((h) => h.checked);
  assert.equal(first.length, 20, 'one batch per run');
  b.run('hourlyBackup');
  const all = list(b).houses;
  assert.ok(all.filter((h) => /^House/.test(h.name)).every((h) => h.photo), 'every new house has its photo');
  // The seeded example.com links 404: recorded once, not refetched within a day.
  const fetchedBefore = b.web.fetched.length;
  b.run('hourlyBackup');
  assert.equal(b.web.fetched.length, fetchedBefore);
});

test('failed listings are retried after a day', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 503, body: '' });
  call(b, { action: 'enrich', id: 'p1' });
  const row = tab(b, 'House Possibilities').getRange(2, 17);
  row.setValue("'2000-01-01 00:00 failed: HTTP 503");
  b.web.pages[RM] = { code: 200, body: rightmovePage() };
  b.run('hourlyBackup');
  assert.equal(byId(b, 'p1').photo, photoUrl());
});

test('a failure while reading listings doesn’t stop the hourly backup', () => {
  const b = setup();
  call(b, { action: 'update', id: 'p1', changes: { link: RM } });
  b.web.pages[RM] = { throws: 'Service invoked too many times' };
  b.run('hourlyBackup');
  assert.equal(tab(b, 'Backups').getLastRow(), 2);
});

test('the menu item fills in everything that needs it', () => {
  const b = setup();
  for (let i = 0; i < 45; i++) call(b, { action: 'create', house: { name: `H${i}`, link: `https://www.rightmove.co.uk/properties/${i}` } });
  b.run('fillListingInfoNow');
  // 45 new + 4 seeded; "No Details Barn" has no link or location, so nothing to read.
  assert.match(b.alerts[0], /^Read the listings of 49 houses\.$/);
  assert.ok(list(b).houses.filter((h) => h.link || h.location).every((h) => h.checked));
});

test('backups keep photos and positions', () => {
  const b = setup();
  withListing(b, 'p1', RM, { code: 200, body: rightmovePage() });
  call(b, { action: 'enrich', id: 'p1' });
  b.run('backupNow');
  call(b, { action: 'delete', id: 'p1' });
  b.run('restoreBackupRow_', 2);
  assert.equal(byId(b, 'p1').photo, photoUrl());
});
