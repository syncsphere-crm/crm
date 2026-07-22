/**
 * gdrive.js
 * Google OAuth (GIS token client) + Drive v3 sync against the hidden
 * `appDataFolder`, which is only ever visible to this app — not to the
 * user's normal Drive UI, and not to other apps. It's tied to whichever
 * Google account signs in, so it's naturally per-account, cross-device sync:
 * sign in with the same account on another device/browser and the same
 * appDataFolder file is there.
 *
 * The backup envelope is encrypted (AES-256-GCM via crypto.js) only if the
 * person sets a master password; otherwise it's uploaded as plain JSON.
 * Google can still see it (this file lives in *your* Drive), but no other
 * app or person can, since appDataFolder is private to this app.
 *
 * NOTE: Replace GOOGLE_CLIENT_ID below with your own OAuth 2.0 Web Client ID
 * from https://console.cloud.google.com/apis/credentials (Authorized
 * JavaScript origin = the GitHub Pages URL this app is hosted at).
 */

const GoogleDrive = (() => {
  const GOOGLE_CLIENT_ID = '819054758887-dj9fhr71ci4e7jl8m6laf6ep4n1qabhh.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
  const BACKUP_FILENAME = 'crm_encrypted_backup.json'; // legacy name kept for compatibility with existing backups
  const EMBED_INDEX_FILENAME = 'crm_semantic_index_v1.json'; // unencrypted — just embedding vectors, no contact text

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let cachedFileId = null;
  let cachedEmbedFileId = null;

  function isConfigured() {
    return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('YOUR_');
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiresAt;
  }

  function initTokenClient() {
    if (tokenClient || typeof google === 'undefined') return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: () => {}, // overridden per-call below
    });
    return tokenClient;
  }

  /** Triggers the Google sign-in popup; resolves once a token is granted.
   * Guarded with a timeout: on some mobile browsers (popup blocked, tab
   * backgrounded, ITP/cookie restrictions) the GIS callback never fires at
   * all, which without this would leave the promise — and the "Sign in"
   * button — hanging forever. */
  function signIn() {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) {
        reject(new Error('Google Client ID not configured. Set GOOGLE_CLIENT_ID in gdrive.js.'));
        return;
      }
      if (typeof google === 'undefined') {
        reject(new Error('Google Identity Services script has not loaded yet.'));
        return;
      }
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Sign-in timed out. Make sure pop-ups are allowed for this site, then try again.'));
      }, 20000);
      const client = initTokenClient();
      client.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3500 * 1000);
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt: isSignedIn() ? '' : 'consent' });
    });
  }

  /**
   * Attempts to restore a session WITHOUT showing any popup or prompt — used
   * on page load so a returning, already-authorized person doesn't have to
   * click "Login" again. Resolves false (never rejects) if there's no
   * existing Google session or the person hasn't authorized this app before;
   * that's an expected, silent outcome, not an error.
   */
  function trySilentSignIn() {
    return new Promise((resolve) => {
      if (!isConfigured() || typeof google === 'undefined') { resolve(false); return; }
      const client = initTokenClient();
      if (!client) { resolve(false); return; }
      let settled = false;
      const timeoutId = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 8000);
      client.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (resp.error) { resolve(false); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3500 * 1000);
        resolve(true);
      };
      try {
        client.requestAccessToken({ prompt: 'none' });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function signOut() {
    if (accessToken && typeof google !== 'undefined') {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    cachedFileId = null;
  }

  async function ensureToken() {
    if (isSignedIn()) return accessToken;
    return signIn();
  }

  async function apiFetch(url, options = {}) {
    const token = await ensureToken();
    const { keepalive, ...fetchOptions } = options;
    const resp = await fetch(url, {
      ...fetchOptions,
      keepalive: !!keepalive, // lets an upload survive a page teardown, unlike sendBeacon this still allows the Authorization header
      headers: {
        ...(fetchOptions.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Drive API error ${resp.status}: ${text}`);
    }
    return resp;
  }

  /** Finds the backup file's fileId inside appDataFolder, if it exists. */
  async function findBackupFileId() {
    if (cachedFileId) return cachedFileId;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${BACKUP_FILENAME}' and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
    });
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const json = await resp.json();
    if (json.files && json.files.length > 0) {
      cachedFileId = json.files[0].id;
      return cachedFileId;
    }
    return null;
  }

  /** Uploads (create or update) the encrypted backup envelope.
   * Pass { keepalive: true } when calling this from a visibilitychange/pagehide
   * handler so the request has a chance to complete after the tab starts
   * tearing down. Note: PATCH-with-keepalive has flakier browser support than
   * POST-with-keepalive, so a keepalive flush always creates-or-recreates the
   * file via POST rather than PATCHing in place. */
  async function uploadBackup(envelopeObject, opts = {}) {
    const keepalive = !!opts.keepalive;
    // During a keepalive flush we avoid the network round-trip findBackupFileId()
    // would make (no time for that mid-teardown) and just reuse whatever file id
    // is already cached from an earlier normal sync in this session, if any.
    const fileId = keepalive ? cachedFileId : await findBackupFileId();
    const body = JSON.stringify(envelopeObject);
    const metadata = { name: BACKUP_FILENAME, mimeType: 'application/json' };

    if (fileId) {
      await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive }
      );
      return fileId;
    }

    const boundary = 'rolodex_boundary_' + Math.random().toString(36).slice(2);
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ ...metadata, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      body +
      `\r\n--${boundary}--`;

    const resp = await apiFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
        keepalive,
      }
    );
    const json = await resp.json();
    cachedFileId = json.id;
    return json.id;
  }

  /** Downloads and JSON-parses the encrypted backup envelope, or null if none exists. */
  async function downloadBackup() {
    const fileId = await findBackupFileId();
    if (!fileId) return null;
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return resp.json();
  }

  /** Same idea as the contact backup, but for the semantic-search embedding
   * cache — lets a second device skip re-embedding contacts that were
   * already indexed elsewhere. Not encrypted: it holds only vectors, no
   * contact text. */
  async function findEmbedIndexFileId() {
    if (cachedEmbedFileId) return cachedEmbedFileId;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${EMBED_INDEX_FILENAME}' and trashed=false`,
      fields: 'files(id,name)',
    });
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const json = await resp.json();
    cachedEmbedFileId = json.files && json.files.length > 0 ? json.files[0].id : null;
    return cachedEmbedFileId;
  }

  async function uploadEmbeddingIndex(indexObject) {
    const fileId = await findEmbedIndexFileId();
    const body = JSON.stringify(indexObject);
    if (fileId) {
      await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
      );
      return fileId;
    }
    const boundary = 'rolodex_boundary_' + Math.random().toString(36).slice(2);
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: EMBED_INDEX_FILENAME, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + body + `\r\n--${boundary}--`;
    const resp = await apiFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipartBody }
    );
    const json = await resp.json();
    cachedEmbedFileId = json.id;
    return json.id;
  }

  async function downloadEmbeddingIndex() {
    const fileId = await findEmbedIndexFileId();
    if (!fileId) return null;
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return resp.json();
  }

  return {
    isConfigured,
    isSignedIn,
    signIn,
    trySilentSignIn,
    signOut,
    uploadBackup,
    downloadBackup,
    uploadEmbeddingIndex,
    downloadEmbeddingIndex,
  };
})();
