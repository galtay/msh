# msh — Martin & Shirley's house hunt

A simple, password-protected website for tracking houses: **Possibilities**,
**Visited** and **Rejected (no visit)**. Designed for phones and tablets, including
older iPads (Safari 10.3+).

- **Front end:** static files (`index.html`, `app.js`, `styles.css`) served by GitHub Pages. No build step.
- **Storage:** a Google Sheet that nobody needs to open, read and written by a small
  Google Apps Script web app (`apps-script/Code.gs`), which also checks the password.

If `config.js` has no API URL, the site runs in **demo mode** and saves to the current browser only.

## One-time setup

### 1. Make the storage spreadsheet (this also imports the existing data)
1. Open the current house-hunting Google Sheet → **File → Make a copy**. Call it e.g. "House Hunt DB".
   The three tabs (`house possibilities`, `visited`, `rejected no visit`) and columns A–J are used as-is.
   Column K gets a hidden ID per house, added automatically.
2. From then on, only the website should edit this copy.

### 2. Add the backend script
1. In the copy: **Extensions → Apps Script**. Replace `Code.gs` with the contents of `apps-script/Code.gs`.
2. **Project Settings (⚙) → Script properties → Add property**: `PASSWORD` = the family password.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (the password check in the script is what protects the data)
4. Authorise it, then copy the **Web app URL** (ends in `/exec`).

### 3. Point the site at it
Put the URL in `config.js`:
```js
window.MSH_API_URL = 'https://script.google.com/macros/s/XXXX/exec';
```
Commit and push.

### 4. Turn on GitHub Pages
Repo **Settings → Pages → Source: GitHub Actions**. Every push to `main` then runs
`.github/workflows/pages.yml`, which publishes the site at `https://<user>.github.io/msh/`.

The workflow replaces every `__VERSION__` placeholder with the commit hash. That gives browsers
fresh file URLs on each release, and lets open copies of the app notice they're out of date
(via `version.json`) and reload themselves. Locally the placeholders stay as they are, and the
update check is skipped.

### 5. On each device
Open the site, enter the password once (it's remembered), then **Share → Add to Home Screen**
so it opens like an app.

### 6. Turn on hourly backups
Reload the spreadsheet; a **House Hunt** menu appears. Choose **Turn on hourly backups** and
authorise it (it asks to run on a timer).

## Changing the backend script later
1. Paste the new `apps-script/Code.gs` over the old code in the Apps Script editor and save.
2. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** This keeps the same URL.
   (*New deployment* would give a new URL, which would then need to go in `config.js`.)
3. Check it took: open the web app URL in a browser. It should say
   `House Hunt API version N is running.` with the `VERSION` from `Code.gs`.

The site shows a red warning if the deployed script is older than it needs (`MIN_API_VERSION` in
`app.js`), and the script keeps answering older copies of the app, so update the script first, then
push the site.

## Listing photos and locations
The script reads each house's listing page for its main photo and map position, and stores them in
columns M–Q (Photo, Latitude, Longitude, Location accuracy, Listing checked):
- **Rightmove** pages give the agent's main photo and the exact pin.
- **Other sites:** the photo the page offers for link previews (`og:image`).
- **No position from the page:** the Location text is looked up instead, marked *approximate*.

A new house, or one whose link changes, is read straight after saving (its photo appears a few
seconds later). The hourly run reads up to 20 houses that still need it, and retries failed pages a
day later. To read everything at once, use **House Hunt → Fill in photos & locations now** in the
spreadsheet. If a listing is taken down and its photo stops loading, the card simply hides it.

Reading pages needs one extra permission (fetching web pages), so Google asks you to authorise again
the first time you deploy this version or use that menu item.

## Backups and restoring
The script keeps snapshots of all three tabs in a hidden **Backups** tab, newest first: one an hour
when anything has changed, kept for a week. From the **House Hunt** menu in the spreadsheet:
- **Back up now** takes a snapshot straight away.
- **Restore selected backup…**: show the tab (**View → Hidden sheets → Backups**), click any cell
  in the row you want, then choose this. The current data is backed up first, so a restore can be
  undone the same way.

The spreadsheet's own **File → Version history** works too, as a second safety net.

## Tests
```sh
npm install
npx playwright install chromium webkit   # once
npm test
```
- `tests/backend.test.js` runs the real `Code.gs` against an in-memory spreadsheet
  (`tests/sheet-mock.js`) that interprets input the way Sheets does (formulas, dates, numbers).
  Listing pages come from `tests/rightmove-page.js`, which builds made-up pages in Rightmove's format.
- `tests/e2e/` drives the site in WebKit (iPad, iPhone) and Chromium (Android) against that backend,
  including slow and failing connections and two devices editing at once.
- `tests/compat.test.js` keeps the code to what older iPads support (ES2017, no flexbox `gap`, …).

Test data is made up; the repo is public, so real house data never goes in it. GitHub runs the tests
on every push and only publishes the site if they pass.

## Notes
- Saves send only what changed, and the script merges them into the row, so two people editing
  different parts of the same house don't overwrite each other. (If both edit the *same* note at the
  same moment, the later save wins.) The list refreshes when the app is reopened, and with ⟳.
- Text is stored exactly as typed: the script writes it as plain text, so phone numbers keep their
  leading 0 and nothing turns into a date or formula.
- To change the password, edit the `PASSWORD` script property. Each device will ask for the new password.
