# Rolodex — Personal CRM

A 100%-client-side, encrypted, local-first personal relationship manager.
No backend server. Runs as a static site (GitHub Pages-ready) and syncs an
encrypted backup to your own Google Drive `appDataFolder`.

## How it's built

| File | Responsibility |
|---|---|
| `index.html` | Layout, modals, templates |
| `styles.css` | Swiss-inspired white theme, Helvetica type, responsive grid |
| `crypto.js` | PBKDF2 (SHA-256, 600k iterations) key derivation + AES-256-GCM encrypt/decrypt |
| `gdrive.js` | Google Identity Services OAuth + Drive v3 `appDataFolder` sync |
| `app.js` | Dexie.js (IndexedDB) persistence, state, search, CRUD, import, reports |
| `vcard.js` | Dependency-free `.vcf` parser |
| `semantic-worker.js` | Web Worker running Transformers.js (`all-MiniLM-L6-v2`) for semantic note search |
| `manifest.json`, `sw.js`, `icons/` | PWA installability + offline app shell |

## Security model

- Your **master password never leaves the device** and is never written to
  disk — the derived AES key lives only in a JS variable for the life of the
  tab (`crypto.js`).
- Everything persisted locally (IndexedDB) or synced to Drive is an
  AES-256-GCM envelope. Google, GitHub Pages, and anyone with access to the
  raw files see ciphertext only.
- Google Drive access uses the `drive.appdata` scope — a hidden per-app
  folder that doesn't show up in the user's normal Drive UI and isn't
  readable by other apps.
- If you forget the master password, the data is unrecoverable by design —
  there is no reset path, since that's the whole point of client-side
  encryption.

## One-time setup

### 1. Google OAuth Client ID (required for Drive sync; app works offline without it)

1. Go to the [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Under **Authorized JavaScript origins**, add the exact origin you'll host
   on, e.g. `https://yourusername.github.io`.
4. Enable the **Google Drive API** for the project.
5. Copy the generated Client ID into `gdrive.js`:
   ```js
   const GOOGLE_CLIENT_ID = 'xxxxxxxx.apps.googleusercontent.com';
   ```
6. While the app is in "Testing" publishing status in the OAuth consent
   screen, add your own Google account as a **test user** or it won't be able
   to sign in.

### 2. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Rolodex personal CRM"
git branch -M main
git remote add origin https://github.com/yourusername/rolodex.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Deploy from branch → `main` / `/root`**.
All asset paths are relative (`./…`), so this also works cleanly if the repo
is served from a subdirectory (`yourusername.github.io/rolodex/`).

### 3. First run

1. Open the deployed URL. Optionally connect Google Drive, or skip and stay
   fully offline/local.
2. Choose a master password — this both encrypts local storage and, if
   signed in, whatever gets synced to Drive.
3. Add contacts, or use the **Import** tab to drop in `.vcf` files exported
   from your phone/Contacts app.

## Notes & limitations

- **AI semantic search** loads a ~25MB model from a CDN on first use (cached
  by the browser afterward) and needs network access the first time; keyword
  search via Fuse.js always works fully offline.
- Sync uses last-write-wins per contact, keyed by `updatedAt` — if you edit
  the same contact offline on two devices before syncing either, the older
  edit is discarded, not merged field-by-field.
- This is a personal-use tool: there's no multi-user auth, sharing, or
  server-side backup. The `.vcf` importer covers common `FN`/`N`, `TEL`,
  `EMAIL`, `NOTE`, `ORG`, and `X-SOCIALPROFILE` fields, not the full vCard
  spec.
