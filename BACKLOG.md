# Backlog

Ideas we've discussed but not built yet. Newest at the top.

## Satellite view on each card

> **Coordinates are done.** Columns N–P hold latitude, longitude and accuracy, read from the listing
> (or looked up from the Location text). What's left is the imagery decision and the card image.

**Why:** Martin and Shirley want a nice view and fields nearby. A satellite image centred on the
house shows the housing density and the open land around it at a glance.

**Plan**
1. **Coordinates.** Store latitude and longitude in two new columns (M, N), filled in by the Apps
   Script for existing houses and whenever a link is added or changed.
   - **From Rightmove (precise):** listing pages carry the exact pin in `window.__PAGE_MODEL`. Its
     `data` property is a JSON string holding one flat array. Find the object that has both
     `latitude` and `circleRadiusOnMap`. Its values are *indexes* into that same array, e.g.
     `arr[obj.latitude]`. The three listings checked on 2026-10-24 all decoded to
     `pinType: "ACCURATE_POINT"` with `circleRadiusOnMap: 0`. A non-zero radius means the pin is
     approximate.
   - **Fallback:** for houses without a Rightmove link (or if the page can't be read), geocode the
     Location text with Apps Script's built-in `Maps.newGeocoder()`. This is usually village- or
     postcode-level, so mark it as approximate.
   - Needs one new script permission: fetching external web pages (`UrlFetchApp`). It doesn't give
     the script access to anything in Drive.
2. **Card image.** Show a satellite thumbnail centred on the house with a small pin, zoomed out
   enough (~zoom 16) to see neighbours and fields. Tapping it opens Google Maps in satellite view at
   that point to pan and zoom (a plain link, so no API cost).
3. **Tests.** Save an anonymised Rightmove page as a fixture to cover the decoding, plus browser tests
   for the card image and the fallback.

**Decisions still open**
- **Imagery provider:**
  - **Google Static Maps** (`maptype=satellite`): best imagery, officially supported. Needs a
    Google Cloud project with billing attached, but should stay within the free monthly allowance
    at this volume. Lock the key to the site's address and to the Static Maps API.
  - **Esri World Imagery tiles:** no key or setup. The terms for keyless use are murky, and the
    imagery can be a little older or softer.
- **Old iPad:** keep it to a plain `<img>`, with no map library on the card.

**Risks**
- Rightmove may block requests from Google's servers. We can only tell once deployed. If it does,
  backfill existing houses from a local script, and use the geocoder for new ones.
- Reading Rightmove pages isn't an official API. It's fine at this personal scale, but it could break
  if they change their page format, and the tests should make that obvious.

## Smaller ideas
- **Shared sort setting:** one sort choice for everyone and every device (today each device
  remembers its own). Would be stored in the sheet.
- **"Date added" column:** "Newest first" currently means bottom of the tab, so a house moved
  between groups counts as newest in its new group. A real date would sort by when it was found.
- **"Show more" on very long notes,** if full-length notes make the cards too tall to scroll through.
- **"What we're looking for" page:** the Criteria tab from the original spreadsheet (deal-breakers
  vs bonuses) as a read-only page.
- **More distances:** distances to other places (Ludlow was dropped; its old values are still in
  column F of the sheet).
