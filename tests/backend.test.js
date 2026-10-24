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
  assert.match(makeBackend().get(), /^House Hunt API version 3 is running\.$/);
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
  assert.equal(res.version, 3);
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
