// Tests for tools/fill-prices.js (the one-off price fill from Rightmove listings).
const test = require('node:test');
const assert = require('node:assert/strict');
const { listingPrice, plan } = require('../tools/fill-prices');
const { rightmovePage } = require('./rightmove-page');

test('reads the price, its wording and whether the listing is live', () => {
  assert.deepEqual(listingPrice(rightmovePage({ price: '£525,000', wording: 'Offers in Region of' })),
    { price: '£525,000', wording: 'Offers in Region of', live: true });
  assert.deepEqual(listingPrice(rightmovePage({ price: '£395,000', wording: '', archived: true })),
    { price: '£395,000', wording: '', live: false });
  assert.equal(listingPrice('<html>no model</html>'), null);
  assert.equal(listingPrice('window.__PAGE_MODEL = {"data":"oops"}'), null);
});

test('plans only safe changes to the price', () => {
  const l = (price, wording = '') => ({ price, wording, live: true });
  assert.deepEqual(plan('', l('£525,000', 'Offers in Region of')), { action: 'fill', price: 'Offers in Region of £525,000' });
  assert.deepEqual(plan('£400,000', l('£400,000', 'Offers Over')), { action: 'reword', price: 'Offers Over £400,000' });
  assert.deepEqual(plan('400000', l('£400,000', 'Offers Over')), { action: 'reword', price: 'Offers Over £400,000' });
  assert.deepEqual(plan('£550,000', l('£550,000')), { action: 'keep' });
  assert.deepEqual(plan('Offers Over £400,000', l('£400,000', 'Offers Over')), { action: 'keep' });
  assert.deepEqual(plan('£500,000', l('£499,995', 'Offers in Region of')), { action: 'correct', price: 'Offers in Region of £499,995' });
  assert.equal(plan('£450,000', l('£475,000', 'Guide Price')).action, 'differs');
  assert.equal(plan('offers welcome', l('£475,000')).action, 'differs');
});
