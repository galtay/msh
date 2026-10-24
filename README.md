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
Repo **Settings → Pages → Deploy from a branch → `main` / root**. The site appears at
`https://<user>.github.io/msh/`.

### 5. On each device
Open the site, enter the password once (it's remembered), then **Share → Add to Home Screen**
so it opens like an app.

## Changing the backend script later
After editing the script, use **Deploy → Manage deployments → Edit → Version: New version**.
That keeps the same URL. A *new deployment* gives a new URL, which would then need to go in `config.js`.

## Notes
- If two people edit the same house at the same moment, the last save wins. The list refreshes when
  the app is reopened, and with the ⟳ button.
- To change the password, edit the `PASSWORD` script property. Each device will ask for the new password.
- Backups: the spreadsheet's version history (**File → Version history**) works as usual.
