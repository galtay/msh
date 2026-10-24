// Builds a fake Rightmove listing page in the same shape as the real ones
// (checked against live pages in October 2026), with made-up content:
//   window.__PAGE_MODEL = {"data": "<JSON of one flat array>", "encoding": ...};
// Object values in the array are indexes into the same array; arr[0] is the root.
function rightmovePage({ lat = 52.5, lng = -2.7, pinType = 'ACCURATE_POINT', radius = 0, photos = 3, id = 123456 } = {}) {
  const arr = [];
  const add = (v) => { arr.push(v); return arr.length - 1; };
  const ref = (v) => add(v);
  const root = add(null);
  const property = add(null);
  const images = [];
  for (let i = 0; i < photos; i++) {
    const base = `https://media.rightmove.co.uk/property-photo/abc/${id}/photo${i}`;
    images.push(add({
      url: ref(`${base}.jpeg`),
      caption: ref(i === 0 ? 'Front {of} "house"' : null), // braces and quotes, to test parsing
      resizedImageUrls: ref({ size135x100: ref(`${base}_max_135x100.jpeg`), size476x317: ref(`${base}_max_476x317.jpeg`), size656x437: ref(`${base}_max_656x437.jpeg`) }),
    }));
  }
  const location = add({ latitude: ref(lat), longitude: ref(lng), circleRadiusOnMap: ref(radius), zoomLevel: ref(15), pinType: ref(pinType), showMap: ref(true) });
  arr[property] = { id: ref(id), images: ref(images), location, text: ref({ description: ref('A made-up house. }{ Not real.') }) };
  arr[root] = { propertyData: property, metadata: ref({}), isAuthenticated: ref(false) };
  const model = { data: JSON.stringify(arr), encoding: 'flat' };
  return `<!doctype html><html><head><title>Made-up listing</title></head><body>
<script>
        window.__PAGE_MODEL = ${JSON.stringify(model)};
        window.adInfo = [{"key":"SO","value":["FALSE"]}];
</script></body></html>`;
}

const photoUrl = (id = 123456) => `https://media.rightmove.co.uk/property-photo/abc/${id}/photo0_max_476x317.jpeg`;

module.exports = { rightmovePage, photoUrl };
