// Shared setup for the browser tests: each test gets its own in-memory sheet
// running the real Code.gs, and the page's calls to the script are routed to it.
const base = require('@playwright/test');
const { makeBackend } = require('../sheet-mock');
const { seed } = require('../fixtures');

const API = 'https://script.test/exec';
const PASSWORD = 'secret';

// `net` lets a test slow the sheet down or make the next requests fail.
function makeNet() {
  return { delay: 0, failures: [], requests: [] };
}

async function connect(target, backend, net) {
  await target.route('**/config.js*', (r) => r.fulfill({
    contentType: 'text/javascript', body: `window.MSH_API_URL = '${API}';`,
  }));
  await target.route(API, async (route) => {
    const body = route.request().postData();
    net.requests.push(JSON.parse(body));
    const failure = net.failures.shift();
    if (failure) return route.fulfill(failure);
    // Like the real script, the change is made even if the page goes away
    // before the answer arrives.
    const result = backend.post(body);
    if (net.delay) await new Promise((r) => setTimeout(r, net.delay));
    try {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    } catch (e) { /* page reloaded or closed meanwhile */ }
  });
}

class App {
  constructor(page) { this.page = page; }
  // Opens the site and logs in with the family password.
  async open() {
    await this.page.goto('/');
    await this.page.fill('#loginForm input', PASSWORD);
    await this.page.click('#loginForm button');
    await this.loaded();
  }
  async loaded() {
    await base.expect(this.page.locator('#refreshBtn')).not.toHaveClass(/spinning/);
    await base.expect(this.page.locator('.card, .empty').first()).toBeVisible();
  }
  async tab(status) { await this.page.click(`.tabs [data-status=${status}]`); }
  card(name) {
    return this.page.locator('.card').filter({ has: this.page.locator('h3', { hasText: name }) });
  }
  rate(name, key, value) { return this.card(name).locator(`[data-key=${key}][data-rate="${value}"]`).click(); }
  mood(name, key) {
    return this.card(name).locator('.field').filter({ has: this.page.locator(`[data-key=${key}]`) });
  }
  async saved() { await base.expect(this.page.locator('#savingNote')).toBeHidden(); }
  async count(status) { return Number(await this.page.locator(`.tabs [data-status=${status}] .count`).textContent()); }
}

const test = base.test.extend({
  backend: async ({}, use) => { await use(seed(makeBackend({ password: PASSWORD }))); },
  net: async ({}, use) => { await use(makeNet()); },
  app: async ({ page, backend, net }, use) => {
    await connect(page, backend, net);
    await use(new App(page));
  },
  // A second device (its own browser storage) talking to the same sheet.
  otherDevice: async ({ browser, backend }, use) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
    await connect(context, backend, makeNet());
    const app = new App(await context.newPage());
    await use(app);
    await context.close();
  },
});

const house = (backend, id) => backend.post({ action: 'list', password: PASSWORD }).houses.find((h) => h.id === id);

module.exports = { test, expect: base.expect, API, PASSWORD, connect, house };
