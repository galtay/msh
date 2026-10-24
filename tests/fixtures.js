// Made-up houses for tests (the repo is public, so never real data).
// Rows are laid out like the real sheet: columns A–J are the fields, K the ID.
// Prices are numbers with £ formatting, as in the imported spreadsheet.

const HEADERS_V1 = ['House name', 'Location', 'Price', 'Link', 'Distance to Shrewsbury',
  'Distance to Ludlow', "Mum's initial thoughts", "Dad's initial thoughts",
  'Actions taken and decision made', 'Estate agent contact', 'ID'];

const price = (n) => `£${n.toLocaleString('en-GB')}`;

const TABS = {
  'House Possibilities': [
    ['Bramble Cottage', 'Testville', price(450000), 'https://example.com/listing/1', '20 mins', '',
      'Lovely garden', 'Roof looks old', '', '', 'p1'],
    ['Old Mill House', 'Sampleton', price(525000), 'https://example.com/listing/2', '', '',
      '', 'Worth a look', 'Called agent', 'Agent A, 01000 000001', 'p2'],
    ['No Details Barn', '', '', '', '', '', '', '', '', '', 'p3'],
  ],
  Visited: [
    ['Hilltop View', 'Exampleford', price(500000), 'https://example.com/listing/3', 'nearest', '',
      'Liked the kitchen', 'Too many stairs', 'Viewed, dead', 'Agent B, 01000 000002', 'v1'],
  ],
  'Rejected No Visit': [
    ['Roadside Lodge', 'Mockbury', price(399000), 'https://example.com/listing/4', '', 'nearest',
      'Too close to the road', 'Agree', 'Dead', '', 'r1'],
  ],
};

// Adds the three house tabs as they were after the original import:
// 11 columns (no Ratings column yet), IDs already filled in.
function seed(backend, { columns = 11 } = {}) {
  Object.keys(TABS).forEach((name) => {
    backend.ss.addSheet(name, { rows: [HEADERS_V1].concat(TABS[name]), maxCols: columns });
  });
  return backend;
}

module.exports = { seed, TABS };
