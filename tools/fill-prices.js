#!/usr/bin/env node
// One-off: fill in house prices from their Rightmove listings, with the
// listing's wording, e.g. "Offers in Region of £525,000". Uses the same web app
// as the site (asks for the family password, hidden as you type), and only
// ever changes the Price field:
//   - empty prices are filled in;
//   - a price equal to the listing's gains the listing's wording;
//   - a price within 1% of the listing's (the old sheet rounded to thousands)
//     is corrected to the listing's;
//   - anything else is listed but left alone.
// It shows the plan and asks before changing anything.
//
//   node tools/fill-prices.js            (or: npm run fill-prices)
//   node tools/fill-prices.js --dry-run  (show the plan only)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API_URL = (fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8').match(/MSH_API_URL = '([^']+)'/) || [])[1];
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// The price, its wording and whether the listing is still up, from a Rightmove
// page's window.__PAGE_MODEL (the same structure Code.gs reads photos from).
function listingPrice(html) {
  try {
    const at = html.indexOf('window.__PAGE_MODEL');
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    let depth = 0; let inString = false; let end = -1;
    for (let i = start; i < html.length && end < 0; i++) {
      const ch = html[i];
      if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; }
      else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) end = i;
    }
    const arr = JSON.parse(JSON.parse(html.slice(start, end + 1)).data);
    const ref = (i) => (typeof i === 'number' && i >= 0 && i < arr.length ? arr[i] : undefined);
    const property = ref(arr[0] && arr[0].propertyData);
    const prices = ref(property.prices) || {};
    const status = ref(property.status) || {};
    const price = ref(prices.primaryPrice);
    if (!price) return null;
    return { price, wording: ref(prices.displayPriceQualifier) || '', live: !ref(status.archived) && ref(status.published) !== false };
  } catch (e) {
    return null;
  }
}

const amount = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// What to do with one house: {action: 'fill'|'reword'|'correct'|'keep'|'differs', price}.
function plan(current, listing) {
  const text = (listing.wording + ' ' + listing.price).trim();
  const ours = amount(current);
  const theirs = amount(listing.price);
  if (!String(current || '').trim()) return { action: 'fill', price: text };
  if (String(current).trim() === text) return { action: 'keep' };
  if (ours === theirs) return listing.wording ? { action: 'reword', price: text } : { action: 'keep' };
  if (ours && theirs && Math.abs(ours - theirs) / theirs <= 0.01) return { action: 'correct', price: text };
  return { action: 'differs', price: text };
}

async function api(password, body) {
  const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...body, password }) });
  const data = JSON.parse(await res.text());
  if (!data.ok) throw new Error(data.error);
  return data;
}

function ask(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question); };
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!API_URL) throw new Error('No MSH_API_URL in config.js');
  const password = process.env.MSH_PASSWORD || await ask('Family password: ', true);
  const { houses } = await api(password, { action: 'list' });
  const changes = [];
  const notes = [];
  for (const h of houses) {
    const id = (String(h.link).match(/rightmove\.co\.uk\/properties\/(\d+)/) || [])[1];
    if (!id) { notes.push(`skip  ${h.name}: not a Rightmove link`); continue; }
    const res = await fetch(`https://www.rightmove.co.uk/properties/${id}`, { headers: { 'User-Agent': BROWSER } }).catch(() => null);
    const listing = res && res.ok ? listingPrice(await res.text()) : null;
    await new Promise((r) => setTimeout(r, 500)); // be polite
    if (!listing) { notes.push(`skip  ${h.name}: couldn't read the listing`); continue; }
    const p = plan(h.price, listing);
    if (!listing.live) notes.push(`note  ${h.name}: listing is no longer live`);
    if (p.action === 'differs') notes.push(`left  ${h.name}: ours "${h.price}", listing "${p.price}"`);
    if (p.price && p.action !== 'differs') changes.push({ id: h.id, name: h.name, from: h.price, to: p.price, action: p.action });
  }
  for (const c of changes) console.log(`${c.action.padEnd(7)} ${c.name}: "${c.from || ''}" → "${c.to}"`);
  notes.forEach((n) => console.log(n));
  console.log(`\n${changes.length} prices to update.`);
  if (dryRun || !changes.length) return;
  if ((await ask('Update them now? (y/N) ')).trim().toLowerCase() !== 'y') return;
  for (const c of changes) {
    await api(password, { action: 'update', id: c.id, changes: { price: c.to } });
    process.stdout.write('.');
  }
  console.log(`\nDone: ${changes.length} prices updated.`);
}

if (require.main === module) main().catch((e) => { console.error('Error:', e.message); process.exit(1); });

module.exports = { listingPrice, plan };
