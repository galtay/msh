const { test, expect, PASSWORD, house } = require('./harness');

// ---------- logging in ----------

test('asks for the password, rejects a wrong one, remembers the right one', async ({ page, app }) => {
  await page.goto('/');
  const login = page.locator('#loginPanel');
  await expect(login).toBeVisible();
  await login.locator('input').fill('wrong');
  await login.locator('button').click();
  await expect(page.locator('#loginError')).toHaveText('Wrong password');
  await login.locator('input').fill(PASSWORD);
  await login.locator('button').click();
  await app.loaded();
  await expect(login).toBeHidden();
  await page.reload();
  await app.loaded();
  await expect(login).toBeHidden();
});

test('log out returns to the password screen', async ({ page, app }) => {
  await app.open();
  await page.click('#logoutBtn');
  await expect(page.locator('#loginPanel')).toBeVisible();
  await page.reload();
  await expect(page.locator('#loginPanel')).toBeVisible();
});

// ---------- cards ----------

test('groups and counts match the sheet', async ({ app }) => {
  await app.open();
  expect(await app.count('possible')).toBe(3);
  expect(await app.count('priority')).toBe(0);
  expect(await app.count('visited')).toBe(1);
  expect(await app.count('rejected')).toBe(1);
  await app.tab('visited');
  await expect(app.card('Hilltop View')).toBeVisible();
  await expect(app.page.locator('.card')).toHaveCount(1);
});

test('newest first is the default; oldest first reverses it', async ({ page, app }) => {
  await app.open();
  await expect(page.locator('#sort')).toHaveValue('newest');
  await expect(page.locator('.card h3').first()).toHaveText('No Details Barn');
  await page.selectOption('#sort', 'sheet');
  await expect(page.locator('.card h3').first()).toHaveText('Bramble Cottage');
});

test('one sort choice applies to every group', async ({ page, app, backend }) => {
  backend.post({ action: 'create', password: PASSWORD, house: { name: 'Second Visit', status: 'visited' } });
  await app.open();
  await page.selectOption('#sort', 'sheet');
  for (const [tab, first] of [['visited', 'Hilltop View'], ['rejected', 'Roadside Lodge'], ['possible', 'Bramble Cottage']]) {
    await app.tab(tab);
    await expect(page.locator('#sort')).toHaveValue('sheet');
    await expect(page.locator('.card h3').first()).toHaveText(first);
  }
  await page.selectOption('#sort', 'newest');
  await app.tab('visited');
  await expect(page.locator('.card h3').first()).toHaveText('Second Visit');
});

test('missing details are highlighted and counted', async ({ app }) => {
  await app.open();
  const empty = app.card('No Details Barn');
  await expect(empty.locator('.todo')).toHaveText('8 details to fill in');
  for (const label of ['price', 'location', 'distance', 'link', 'Mum’s thoughts', 'Dad’s thoughts', 'actions', 'estate agent']) {
    await expect(empty.locator('.missing', { hasText: `+ Add ${label}` })).toBeVisible();
  }
  await expect(app.card('Bramble Cottage').locator('.todo')).toHaveText('2 details to fill in');
});

test('no Ludlow distance and no "nearest" on any card', async ({ page, app }) => {
  await app.open();
  for (const tab of ['possible', 'visited', 'rejected']) {
    await app.tab(tab);
    await expect(page.locator('.card .fact', { hasText: /ludlow/i })).toHaveCount(0);
    await expect(page.locator('.card', { hasText: /nearest/i })).toHaveCount(0);
  }
  await app.tab('visited');
  await expect(app.card('Hilltop View').locator('[data-fill=distShrewsbury]')).toBeVisible();
});

test('text from the sheet is shown as text, never as HTML', async ({ page, app, backend }) => {
  backend.post({ action: 'create', password: PASSWORD, house: { name: '<img src=x onerror="window.pwned=1">', shirley: '<b>bold?</b>' } });
  await app.open();
  await expect(page.locator('.card h3', { hasText: '<img src=x' })).toBeVisible();
  await expect(page.locator('.field-text', { hasText: '<b>bold?</b>' })).toBeVisible();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('notes are shown in full, keeping their line breaks', async ({ app, backend }) => {
  const long = 'First paragraph. ' + 'More detail about the house. '.repeat(30) +
    '\n\nUpdate: decided against it. https://example.com/' + 'a-very-long-link-'.repeat(8);
  backend.post({ action: 'update', password: PASSWORD, id: 'p1', changes: { actions: long } });
  await app.open();
  const text = app.card('Bramble Cottage').locator('.field-text', { hasText: 'Update: decided' });
  await expect(text).toBeVisible();
  const box = await text.evaluate((el) => {
    const kept = el.getBoundingClientRect().height;
    el.style.whiteSpace = 'normal'; // what it would look like with the line breaks lost
    const lost = el.getBoundingClientRect().height;
    el.style.whiteSpace = '';
    return {
      clipped: el.scrollHeight > el.clientHeight + 1,
      overflowsCard: el.scrollWidth > el.clientWidth + 1,
      lineBreaksKept: kept > lost,
    };
  });
  expect(box.clipped).toBe(false);
  expect(box.overflowsCard).toBe(false);
  expect(box.lineBreaksKept).toBe(true);
});

test('only Mum’s and Dad’s thoughts have rating buttons', async ({ app }) => {
  await app.open();
  const keys = await app.card('Old Mill House').locator('.rate').evaluateAll((b) => b.map((x) => x.dataset.key));
  expect([...new Set(keys)]).toEqual(['martin']); // Mum's is empty, so only Dad's block shows
  await expect(app.mood('Old Mill House', 'martin')).toHaveClass(/neutral/);
});

// ---------- ratings ----------

test('ratings colour the block, toggle off, and are stored in the sheet', async ({ app, backend }) => {
  await app.open();
  await app.rate('Bramble Cottage', 'shirley', '+');
  await app.rate('Bramble Cottage', 'martin', '-');
  await expect(app.mood('Bramble Cottage', 'shirley')).toHaveClass(/pos/);
  await expect(app.mood('Bramble Cottage', 'martin')).toHaveClass(/neg/);
  await app.saved();
  expect(JSON.parse(house(backend, 'p1').ratings)).toEqual({ shirley: '+', martin: '-' });

  await app.rate('Bramble Cottage', 'martin', '-'); // tap again: back to neutral
  await expect(app.mood('Bramble Cottage', 'martin')).toHaveClass(/neutral/);
  await app.saved();
  expect(JSON.parse(house(backend, 'p1').ratings)).toEqual({ shirley: '+' });
});

test('a rating survives switching tabs and reloading straight away', async ({ page, app, net }) => {
  net.delay = 800; // a slow sheet
  page.on('dialog', (d) => d.accept()); // "Leave page?" while saving: yes
  await app.open();
  await app.tab('rejected');
  await app.rate('Roadside Lodge', 'martin', '-');
  await expect(page.locator('#savingNote')).toBeVisible();
  await app.tab('possible');
  await page.reload(); // while the save is still on its way
  await app.loaded();
  await app.tab('rejected');
  await expect(app.mood('Roadside Lodge', 'martin')).toHaveClass(/neg/);
});

test('a refresh during pending saves waits for them', async ({ page, app, net }) => {
  net.delay = 500;
  await app.open();
  await app.rate('Bramble Cottage', 'shirley', '+');
  await app.rate('Bramble Cottage', 'martin', '+');
  await page.click('#refreshBtn');
  await app.saved();
  await expect(page.locator('#refreshBtn')).not.toHaveClass(/spinning/);
  await expect(app.mood('Bramble Cottage', 'shirley')).toHaveClass(/pos/);
  await expect(app.mood('Bramble Cottage', 'martin')).toHaveClass(/pos/);
  const actions = net.requests.map((r) => r.action);
  expect(actions.lastIndexOf('update')).toBeLessThan(actions.lastIndexOf('list'));
});

test('a failed rating goes back to how it was and says why', async ({ page, app, net, backend }) => {
  await app.open();
  net.failures.push({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"Sheet is busy"}' });
  await app.rate('Bramble Cottage', 'shirley', '+');
  await expect(page.locator('#toast')).toContainText('Rating not saved: Sheet is busy');
  await expect(app.mood('Bramble Cottage', 'shirley')).toHaveClass(/neutral/);
  expect(house(backend, 'p1').ratings).toBe('');
});

// ---------- two devices ----------

test('changes from two devices to the same house both survive', async ({ page, app, otherDevice, backend }) => {
  await app.open();
  await otherDevice.open();

  // Dad opens the form on his device first and starts typing...
  await otherDevice.card('Old Mill House').locator('h3').click();
  await otherDevice.page.fill('[name=martin]', 'Changed my mind, love it');

  // ...meanwhile Mum rates his note and updates the actions on hers...
  await app.rate('Old Mill House', 'martin', '+');
  await app.card('Old Mill House').locator('h3').click();
  await page.fill('[name=actions]', 'Viewing booked for Friday');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  await app.saved();

  // ...then Dad saves. His form still shows the old actions, which mustn't win.
  await otherDevice.page.click('.panel-head button[type=submit]');
  await expect(otherDevice.page.locator('#editPanel')).toBeHidden();

  const h = house(backend, 'p2');
  expect(h.martin).toBe('Changed my mind, love it');
  expect(h.actions).toBe('Viewing booked for Friday');
  expect(JSON.parse(h.ratings)).toEqual({ martin: '+' });
});

test('another device’s changes appear when the app comes back into view', async ({ app, otherDevice }) => {
  await app.open();
  await otherDevice.open();
  await otherDevice.rate('Bramble Cottage', 'shirley', '-');
  await otherDevice.saved();
  await app.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(app.mood('Bramble Cottage', 'shirley')).toHaveClass(/neg/);
});

// ---------- moving ----------

test('move to another group, then undo', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Bramble Cottage').locator('[data-move=rejected]').click();
  await expect(app.card('Bramble Cottage')).toHaveCount(0);
  expect(await app.count('rejected')).toBe(2);
  await page.locator('#toast button', { hasText: 'Undo' }).click();
  await expect(app.card('Bramble Cottage')).toBeVisible();
  await app.saved();
  expect(house(backend, 'p1').status).toBe('possible');
  const all = backend.post({ action: 'list', password: PASSWORD }).houses.filter((h) => h.id === 'p1');
  expect(all).toHaveLength(1);
});

test('a failed move puts the house back', async ({ page, app, net, backend }) => {
  await app.open();
  net.failures.push({ status: 500, contentType: 'text/html', body: '<html>Google error</html>' });
  await app.card('Bramble Cottage').locator('[data-move=visited]').click();
  await expect(page.locator('#toast')).toContainText('Not moved: unexpected reply from the sheet (HTTP 500)');
  await expect(app.card('Bramble Cottage')).toBeVisible();
  expect(house(backend, 'p1').status).toBe('possible');
});

// ---------- the edit form ----------

test('“+ Add” opens the form at that field and saves it', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Old Mill House').locator('[data-fill=shirley]').click();
  await expect(page.locator('#editPanel')).toBeVisible();
  await expect(page.locator('[name=shirley]')).toBeFocused();
  await page.fill('[name=shirley]', 'Gorgeous beams');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  await expect(app.mood('Old Mill House', 'shirley')).toContainText('Gorgeous beams');
  expect(house(backend, 'p2').shirley).toBe('Gorgeous beams');
});

test('saving an unchanged form sends nothing', async ({ page, app, net }) => {
  await app.open();
  await app.card('Bramble Cottage').locator('h3').click();
  const before = net.requests.length;
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  expect(net.requests.length).toBe(before);
});

test('editing keeps fields the form doesn’t show (Ludlow distance, ratings)', async ({ page, app, backend }) => {
  await app.open();
  await app.rate('Bramble Cottage', 'shirley', '+');
  await app.saved();
  await app.tab('rejected');
  await app.card('Roadside Lodge').locator('h3').click();
  await page.fill('[name=agent]', 'Agent C');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  expect(house(backend, 'r1').distLudlow).toBe('nearest');
  expect(JSON.parse(house(backend, 'p1').ratings)).toEqual({ shirley: '+' });
});

test('add a new house; awkward text is kept exactly as typed', async ({ page, app, backend }) => {
  await app.open();
  await page.click('#addBtn');
  await page.fill('[name=name]', '=Not A Formula');
  await page.fill('[name=price]', '£610,000');
  await page.fill('[name=agent]', '01743 000000');
  await page.fill('[name=actions]', '10/14');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  const created = backend.post({ action: 'list', password: PASSWORD }).houses.find((h) => h.name === '=Not A Formula');
  expect(created).toMatchObject({ status: 'possible', price: '£610,000', agent: '01743 000000', actions: '10/14' });
  await expect(app.card('=Not A Formula').locator('.price')).toHaveText('£610,000');
});

test('a house needs a name', async ({ page, app, net }) => {
  await app.open();
  await page.click('#addBtn');
  const before = net.requests.length;
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#toast')).toContainText('Please give the house a name');
  await expect(page.locator('#editPanel')).toBeVisible();
  expect(net.requests.length).toBe(before);
});

test('moving via the Group dropdown in the form', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Bramble Cottage').locator('h3').click();
  await page.selectOption('[name=status]', 'visited');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('.tabs [data-status=visited]')).toHaveClass(/active/);
  await expect(app.card('Bramble Cottage')).toBeVisible();
  expect(house(backend, 'p1').status).toBe('visited');
});

test('delete asks first, then removes the house', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Old Mill House').locator('h3').click();
  page.once('dialog', (d) => d.dismiss());
  await page.click('#deleteBtn');
  expect(house(backend, 'p2')).toBeDefined();
  page.once('dialog', (d) => d.accept());
  await page.click('#deleteBtn');
  await expect(app.card('Old Mill House')).toHaveCount(0);
  expect(house(backend, 'p2')).toBeUndefined();
});

test('a failed form save keeps the form open with the typing intact', async ({ page, app, net }) => {
  await app.open();
  await app.card('Bramble Cottage').locator('h3').click();
  await page.fill('[name=actions]', 'Important note');
  net.failures.push({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"Sheet is busy"}' });
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#toast')).toContainText('Not saved: Sheet is busy');
  await expect(page.locator('#editPanel')).toBeVisible();
  await expect(page.locator('[name=actions]')).toHaveValue('Important note');
});

test('a house deleted on another device gives a clear message', async ({ page, app, otherDevice }) => {
  await app.open();
  await otherDevice.open();
  await otherDevice.card('Old Mill House').locator('h3').click();
  otherDevice.page.once('dialog', (d) => d.accept());
  await otherDevice.page.click('#deleteBtn');
  await expect(otherDevice.card('Old Mill House')).toHaveCount(0);
  await app.rate('Old Mill House', 'martin', '+');
  await expect(page.locator('#toast')).toContainText('no longer in the sheet');
});

// ---------- the script and the connection ----------

test('warns when the deployed script is too old', async ({ page, app }) => {
  await page.route('https://script.test/exec', (r) => r.fulfill({
    contentType: 'application/json', body: JSON.stringify({ ok: true, houses: [] }), // no version: an old script
  }));
  await app.open();
  await expect(page.locator('#banner')).toContainText('script is out of date');
});

test('an old script that lacks an action says it needs redeploying', async ({ page, app, net }) => {
  await app.open();
  net.failures.push({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"Unknown action: update"}' });
  await app.rate('Bramble Cottage', 'shirley', '+');
  await expect(page.locator('#toast')).toContainText('needs redeploying');
});

test('loading fails gracefully when the sheet cannot be reached', async ({ page, app, net }) => {
  net.failures.push({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
  await page.addInitScript((pw) => localStorage.setItem('msh.password', pw), PASSWORD);
  await page.goto('/');
  await expect(page.locator('#banner')).toContainText('Couldn’t load the list');
  await expect(page.locator('#refreshBtn')).not.toHaveClass(/spinning/);
  await page.click('#refreshBtn');
  await expect(page.locator('#banner')).toBeHidden();
  await expect(app.card('Bramble Cottage')).toBeVisible();
});

test('a changed password sends everyone back to the login screen', async ({ page, app, backend }) => {
  await app.open();
  await page.evaluate(() => localStorage.setItem('msh.password', 'old-password'));
  await page.click('#refreshBtn');
  await expect(page.locator('#loginPanel')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('msh.password'))).toBeNull();
});

// ---------- updates and appearance ----------

test('a stale copy of the app reloads itself onto the new version', async ({ page, app }) => {
  // Pretend this copy is release "aaa" while the server has moved on to "bbb".
  await page.route(/\/app\.js/, async (r) => {
    const res = await r.fetch();
    r.fulfill({ response: res, body: (await res.text()).replace("'__VERSION__'", "'aaa'") });
  });
  await page.route(/\/version\.json/, (r) => r.fulfill({ contentType: 'application/json', body: '{"version":"bbb"}' }));
  await app.open();
  await page.waitForURL(/\?v=bbb$/);
  // Still "aaa" after the reload (the route above), but it mustn't loop.
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\?v=bbb$/);
});

test('stays in light mode even when the device is set to dark', async ({ browser, backend }) => {
  const { connect } = require('./harness');
  const context = await browser.newContext({ baseURL: 'http://localhost:4173', colorScheme: 'dark' });
  await connect(context, backend, { delay: 0, failures: [], requests: [] });
  const page = await context.newPage();
  await page.addInitScript((pw) => localStorage.setItem('msh.password', pw), PASSWORD);
  await page.goto('/');
  await expect(page.locator('.card').first()).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(246, 243, 238)');
  await context.close();
});

test('fits the screen without sideways scrolling, with finger-sized buttons', async ({ page, app }) => {
  await app.open();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const width of [page.viewportSize().width, 320]) {
    await page.setViewportSize({ width, height: page.viewportSize().height });
    // Tab labels shrink to fit after a resize (fitTabs), so allow a moment.
    await expect.poll(() => page.locator('.tabs button, .move-btn').evaluateAll((els) =>
      els.filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent.trim())),
    { message: `labels cut off at ${width}px` }).toEqual([]);
  }
  for (const sel of ['.rate', '.move-btn', '.missing', '.tabs button', '#addBtn']) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(34);
  }
});

// ---------- duplicates ----------

async function addHouse(page, fields) {
  await page.click('#addBtn');
  for (const [k, v] of Object.entries(fields)) await page.fill(`[name=${k}]`, v);
  await page.click('.panel-head button[type=submit]');
}

const allHouses = (backend) => backend.post({ action: 'list', password: PASSWORD }).houses;

test('warns when adding a listing that is already in another group', async ({ page, app, backend }) => {
  backend.post({ action: 'create', password: PASSWORD, house: {
    name: 'Calves Hill Barn', location: 'Haughton', status: 'rejected',
    link: 'https://www.rightmove.co.uk/properties/88117197#/?channel=RES_BUY' } });
  await app.open();
  // Same listing, copied differently, under another name.
  await addHouse(page, { name: 'Barn near Bridgnorth', link: 'https://rightmove.co.uk/properties/88117197?utm=share' });
  const dup = page.locator('#dupPanel');
  await expect(dup).toBeVisible();
  await expect(dup).toContainText('This looks like Calves Hill Barn (Haughton), already in Rejected. It has the same listing link.');

  // Go back: the form and its typing are still there; nothing was saved.
  await page.click('#dupBack');
  await expect(dup).toBeHidden();
  await expect(page.locator('[name=name]')).toHaveValue('Barn near Bridgnorth');
  expect(allHouses(backend).filter((h) => h.name === 'Barn near Bridgnorth')).toHaveLength(0);

  // Show the existing one: jumps to its group and highlights it.
  await page.click('.panel-head button[type=submit]');
  await page.click('#dupShow');
  await expect(page.locator('#editPanel')).toBeHidden();
  await expect(page.locator('.tabs [data-status=rejected]')).toHaveClass(/active/);
  await expect(app.card('Calves Hill Barn')).toHaveClass(/flash/);
  expect(allHouses(backend).filter((h) => h.name === 'Barn near Bridgnorth')).toHaveLength(0);
});

test('“Add anyway” saves the house despite the warning', async ({ page, app, backend }) => {
  await app.open();
  await addHouse(page, { name: 'bramble  cottage!', location: 'TESTVILLE' }); // same name and place as p1
  await expect(page.locator('#dupPanel')).toContainText('Bramble Cottage (Testville), already in Possibilities. It has the same name and location.');
  await page.click('#dupSave');
  await expect(page.locator('#editPanel')).toBeHidden();
  expect(allHouses(backend).filter((h) => textKeyNode(h.name) === 'bramble cottage')).toHaveLength(2);
});

test('a house just added on another device is caught too', async ({ page, app, otherDevice }) => {
  await app.open();
  await otherDevice.open();
  await addHouse(otherDevice.page, { name: 'Fresh Listing', link: 'https://www.zoopla.co.uk/for-sale/details/12345/' });
  await expect(otherDevice.card('Fresh Listing')).toBeVisible();
  // This device hasn't refreshed since, but the check fetches the latest list first.
  await addHouse(page, { name: 'Same Place', link: 'https://zoopla.co.uk/for-sale/details/12345?search=1' });
  await expect(page.locator('#dupPanel')).toContainText('Fresh Listing');
});

test('different houses, and edits that keep the link, raise no warning', async ({ page, app, backend }) => {
  await app.open();
  await addHouse(page, { name: 'Bramble Cottage', location: 'Elsewhere' }); // same name, different place
  await expect(page.locator('#editPanel')).toBeHidden();
  await expect(page.locator('#dupPanel')).toBeHidden();
  await addHouse(page, { name: 'Another', link: 'https://example.com/listing/99' });
  await expect(page.locator('#editPanel')).toBeHidden();
  // Editing a note on an existing house doesn't check at all.
  await app.card('Old Mill House').locator('h3').click();
  await page.fill('[name=shirley]', 'Edited');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#editPanel')).toBeHidden();
  await expect(page.locator('#dupPanel')).toBeHidden();
});

test('changing a house’s link to another house’s listing warns, and can be saved anyway', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Old Mill House').locator('h3').click();
  await page.fill('[name=link]', 'https://example.com/listing/1/'); // Bramble Cottage's
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('#dupPanel')).toContainText('Bramble Cottage');
  await expect(page.locator('#dupSave')).toHaveText('Save anyway');
  await page.click('#dupSave');
  await expect(page.locator('#editPanel')).toBeHidden();
  expect(house(backend, 'p2').link).toBe('https://example.com/listing/1/');
});

test('listing links are matched however they were copied', async ({ page, app }) => {
  await app.open();
  const keys = await page.evaluate(() => [
    'https://www.rightmove.co.uk/properties/88233060#/?channel=RES_BUY',
    'http://rightmove.co.uk/properties/88233060',
    'https://www.rightmove.co.uk/property-for-sale/property-88233060.html',
    'https://www.zoopla.co.uk/for-sale/details/123/?x=1',
    'https://zoopla.co.uk/for-sale/details/123',
    '',
  ].map(listingKey));
  expect(keys).toEqual(['rightmove:88233060', 'rightmove:88233060', 'rightmove:88233060',
    'zoopla.co.uk/for-sale/details/123', 'zoopla.co.uk/for-sale/details/123', '']);
});

function textKeyNode(v) { return String(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// ---------- listing photos and locations ----------

const { rightmovePage, photoUrl } = require('../rightmove-page');
const RM_LINK = 'https://www.rightmove.co.uk/properties/123456';

function giveListing(backend, id) {
  backend.post({ action: 'update', password: PASSWORD, id, changes: { link: RM_LINK } });
  backend.web.pages[RM_LINK] = { code: 200, body: rightmovePage({ lat: 52.559692, lng: -2.475935 }) };
  backend.post({ action: 'enrich', password: PASSWORD, id });
}

test('cards show the listing’s main photo, which opens the listing', async ({ app, backend }) => {
  giveListing(backend, 'p1');
  await app.open();
  const photo = app.card('Bramble Cottage').locator('.photo');
  await expect(photo).toHaveAttribute('href', RM_LINK);
  await expect(photo.locator('img')).toHaveAttribute('src', photoUrl());
  expect(await photo.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(app.card('Old Mill House').locator('.photo')).toHaveCount(0);
});

test('the map link goes to the exact spot when the listing gave one', async ({ app, backend }) => {
  giveListing(backend, 'p1');
  await app.open();
  await expect(app.card('Bramble Cottage').locator('a.fact.place')).toHaveAttribute('href', /query=52\.559692%2C-2\.475935$/);
  await expect(app.card('Old Mill House').locator('a.fact.place')).toHaveAttribute('href', /query=Sampleton%2C%20UK$/);
});

test('a new house’s photo appears shortly after saving', async ({ page, app, backend }) => {
  backend.web.pages['https://www.rightmove.co.uk/properties/777'] = { code: 200, body: rightmovePage({ id: 777 }) };
  await app.open();
  await page.click('#addBtn');
  await page.fill('[name=name]', 'Photo Test');
  await page.fill('[name=link]', 'https://www.rightmove.co.uk/properties/777');
  await page.click('.panel-head button[type=submit]');
  await expect(app.card('Photo Test').locator('.photo img')).toHaveAttribute('src', photoUrl(777));
});

test('a photo that no longer loads is hidden, not shown broken', async ({ app, backend }) => {
  giveListing(backend, 'p1');
  const sheet = backend.ss.getSheetByName('House Possibilities');
  sheet.getRange(2, 13).setValue("'https://media.rightmove.co.uk/property-photo/missing.jpeg");
  await app.open();
  await expect(app.card('Bramble Cottage').locator('.photo')).toBeHidden();
  await expect(app.card('Bramble Cottage').locator('h3')).toBeVisible();
});

test('prices with wording show it small, and still sort by amount', async ({ page, app, backend }) => {
  for (const [name, price] of [['Offer Region', 'Offers in Region of £525,000'], ['Plain Number', '310000'], ['Guide', 'Guide Price £499,950']]) {
    backend.post({ action: 'create', password: PASSWORD, house: { name, price } });
  }
  await app.open();
  const card = app.card('Offer Region');
  await expect(card.locator('.price-wording')).toHaveText('Offers in Region of');
  await expect(card.locator('.price')).toHaveText('Offers in Region of£525,000');
  await expect(app.card('Plain Number').locator('.price')).toHaveText('£310,000');
  await page.selectOption('#sort', 'priceAsc');
  const names = await page.locator('.card h3').allTextContents();
  const order = ['Plain Number', 'Bramble Cottage', 'Guide', 'Old Mill House', 'Offer Region'];
  expect(names.filter((n) => order.includes(n))).toEqual(order);
});

// ---------- Priority ----------

test('the tabs run Possibilities, Schedule/d, Visited, Rejected', async ({ page, app }) => {
  await app.open();
  const tabs = await page.locator('.tabs button').evaluateAll((b) => b.map((x) => x.firstChild.textContent.trim()));
  expect(tabs).toEqual(['Possibilities', 'Schedule/d', 'Visited', 'Rejected']);
});

test('promote a possibility to Schedule/d, then on to Visited', async ({ page, app, backend }) => {
  await app.open();
  const moves = await app.card('Bramble Cottage').locator('.move-btn').allTextContents();
  expect(moves).toEqual(['Schedule/d', 'Visited', 'Rejected']);
  await app.card('Bramble Cottage').locator('[data-move=priority]').click();
  await expect(page.locator('#toast')).toContainText('Moved to Schedule/d');
  await app.saved();
  expect(house(backend, 'p1').status).toBe('priority');
  expect(await app.count('priority')).toBe(1);

  await app.tab('priority');
  const fromPriority = await app.card('Bramble Cottage').locator('.move-btn').allTextContents();
  expect(fromPriority).toEqual(['Possibilities', 'Visited', 'Rejected']);
  await app.card('Bramble Cottage').locator('[data-move=visited]').click();
  await app.saved();
  expect(house(backend, 'p1').status).toBe('visited');
  expect(backend.ss.getSheetByName('priority').displayRows()).toHaveLength(1); // just the header
});

test('Schedule/d can be chosen in the form too', async ({ page, app, backend }) => {
  await app.open();
  await app.card('Old Mill House').locator('h3').click();
  await page.selectOption('[name=status]', 'priority');
  await page.click('.panel-head button[type=submit]');
  await expect(page.locator('.tabs [data-status=priority]')).toHaveClass(/active/);
  await expect(app.card('Old Mill House')).toBeVisible();
  expect(house(backend, 'p2').status).toBe('priority');
});
