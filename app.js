/**
 * app.js - Core UI, Storage, PFP logic, SyncSphere Integrations, and Semantic Worker
 */
const STORAGE_KEY = 'syncsphere_contacts_v1';

window.state = {
  contacts: [],
  activeView: 'directory',
  filterValue: '', // '' | 'tag:<name>' | 'rel:<contactId>'
  overdueOnly: false,
  searchQuery: '',
  aiSearchEnabled: false,
  handleRowsDraft: [],
  customFieldsDraft: [],
  relationRowsDraft: [],
  interactionsDraft: [],
  pendingPfpBase64: null,
  dirty: false, // true when local data has changes not yet pushed to Drive
  dismissedMergePairs: new Set(), // session-only, "idA|idB" sorted
};

let semanticWorker = null;
let promptInterval = null;
let gemmaCapability = null; // { supported: bool, reason?: string }
let lastSemanticQueryText = '';
const EXAMPLE_PROMPTS = [
  'Try: "Who works at Google?"',
  'Try: "Friends from college"',
  'Try: "Software developer in NYC"',
  'Try: "How many people are overdue?" (press Enter)'
];

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11));

function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

const els = {};
function cacheEls() {
  const ids = [
    'globalSearch','settingsBtn','contactGrid','emptyState','filterSelect',
    'overdueFilterBtn','resultCount','addContactBtn','reportOverdue',
    'reportTags','exportRawBtn','exportCsvBtn','dropZone','triggerVcfBtn','vcfInput','contactModal',
    'contactModalTitle','contactId','fullNameInput','tagsInput','frequencyInput', 'frequencyUnitInput',
    'companyInput', 'jobTitleInput', 'schoolInput', 'locationInput',
    'handleRows','addHandleBtn','relationRows','relationSearchInput','relationSearchResults',
    'notesInput','addInteractionBtn','interactionList','deleteContactBtn',
    'saveContactBtn','interactionModal','quickInteractionContactId','quickChannelInput',
    'quickSummaryInput','saveQuickInteractionBtn','settingsModal','wipeLocalBtn',
    'pfpInput', 'pfpPreview', 'pfpImg', 'pfpInitial', 'removePfpBtn',
    'gdriveLoginBtn', 'gdriveSyncBtn', 'masterPasswordInput', 'syncStatusLine',
    'syncBtn', 'syncBtnIcon', 'syncBtnLabel',
    'aiToggleBtn', 'aiStatus', 'searchInputContainer', 'aiCapabilityLine',
    'mergeContactsBtn', 'mergeAllBtn', 'mergeModal', 'mergePrimarySelect', 'mergeSecondarySelect', 'confirmMergeBtn',
    'mergeSuggestions',
    'aiIsland', 'aiIslandTitle', 'aiIslandBody', 'aiIslandClose', 'aiModelStatus',
    'appShell', 'lockScreen', 'lockGoogleStep', 'googleLoginBtn', 'lockGoogleError', 'continueOfflineBtn',
    'nicknameInput', 'middleNameInput', 'departmentInput', 'websiteInput', 'birthdayInput',
    'addressStreetInput', 'addressCityInput', 'addressRegionInput', 'addressPostalInput', 'addressCountryInput',
    'customFieldRows', 'addCustomFieldBtn',
    'welcomeImportModal', 'welcomeImportNowBtn', 'welcomeImportLaterBtn',
  ];
  ids.forEach((id) => { 
    els[id] = document.getElementById(id); 
  });
}

// --- Storage & Sync ---
function loadAllFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    window.state.contacts = raw ? JSON.parse(raw) : [];
  } catch (e) { window.state.contacts = []; }
}

function saveAllToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state.contacts));
  window.state.dirty = true;
  updateSyncButtonState('dirty');
  indexSemanticSearch();
}

const DRIVE_CONNECTED_KEY = 'rolodex_drive_connected_v1';
const LAST_SYNC_KEY = 'rolodex_last_synced_v1';
const ONBOARDING_SEEN_KEY = 'rolodex_onboarding_seen_v1';

/** Shown once, right after a Google sign-in finishes syncing, if it turns
 * out this account has no contacts yet (fresh Drive AND nothing local) —
 * a strong signal this is a new user who could use a one-time nudge and
 * some directions for importing their existing contacts. Only ever offered
 * once per device, regardless of what they choose, so it doesn't nag. */
async function maybeShowWelcomeImport() {
  if (localStorage.getItem(ONBOARDING_SEEN_KEY) === 'true') return;
  localStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
  const active = window.state.contacts.filter(c => !c.isDeleted);
  if (active.length > 0) return;
  if (els.welcomeImportModal) els.welcomeImportModal.hidden = false;
}

/**
 * Merge a remote contact list into the local one, per-contact last-write-wins
 * by updatedAt. This is what actually makes multi-device sync safe: a Drive
 * load overwriting window.state.contacts wholesale could silently erase edits
 * made locally after the last sync.
 */
function mergeContactsLWW(localContacts, remoteContacts) {
  const byId = new Map(localContacts.map(c => [c.id, c]));
  remoteContacts.forEach((remote) => {
    const local = byId.get(remote.id);
    if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
      byId.set(remote.id, remote);
    }
  });
  return Array.from(byId.values());
}

function updateDriveUI() {
  const signedIn = GoogleDrive.isSignedIn();
  if (els.gdriveLoginBtn) {
    els.gdriveLoginBtn.textContent = signedIn ? 'Connected (tap to disconnect)' : 'Login to Google Drive';
  }
  if (els.syncStatusLine) {
    if (!signedIn) {
      els.syncStatusLine.textContent = 'Not connected';
    } else {
      const last = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
      els.syncStatusLine.textContent = last ? `Last synced ${timeAgo(last)}` : 'Connected — not yet synced';
    }
  }
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** One button, three visual states: dirty (unsynced changes) / syncing / synced. */
function updateSyncButtonState(state) {
  if (!els.syncBtn) return;
  els.syncBtn.classList.remove('syncing', 'synced', 'sync-error');
  if (state === 'syncing') {
    els.syncBtn.classList.add('syncing');
    if (els.syncBtnLabel) els.syncBtnLabel.textContent = 'Syncing…';
  } else if (state === 'synced') {
    els.syncBtn.classList.add('synced');
    if (els.syncBtnLabel) els.syncBtnLabel.textContent = 'Synced';
    setTimeout(() => { if (els.syncBtnLabel) els.syncBtnLabel.textContent = 'Sync'; els.syncBtn.classList.remove('synced'); }, 2500);
  } else if (state === 'error') {
    els.syncBtn.classList.add('sync-error');
    if (els.syncBtnLabel) els.syncBtnLabel.textContent = 'Retry sync';
  } else {
    if (els.syncBtnLabel) els.syncBtnLabel.textContent = 'Sync';
  }
}

/**
 * ONE unified sync action (replaces the old separate "Save to Drive" /
 * "Load from Drive" buttons): downloads whatever is on Drive, merges it
 * with local changes (last-write-wins per contact), saves the merged result
 * locally, then uploads that same merged result back — so both sides end
 * up consistent in a single action. This is what runs automatically right
 * after login, and what the prominent header "Sync" button triggers by hand.
 */
async function runFullSync(opts = {}) {
  const silent = !!opts.silent;
  if (!GoogleDrive.isSignedIn()) { if (!silent) toast('Please login to Google Drive first.'); return; }

  updateSyncButtonState('syncing');
  try {
    // 1. Pull remote and merge in.
    const payload = await GoogleDrive.downloadBackup();
    if (payload) {
      const isEncrypted = payload.encrypted === true || (payload.iv && typeof payload.data === 'string');
      let remoteContacts = null;

      if (isEncrypted) {
        const pwd = els.masterPasswordInput.value.trim();
        if (!pwd) {
          if (!silent) toast('This backup is encrypted — enter the master password, then hit Sync again.');
          updateSyncButtonState('error');
          return;
        }
        if (!CryptoEngine.hasExistingVault()) {
          await CryptoEngine.initializeVault(pwd);
        } else if (!(await CryptoEngine.unlockVault(pwd))) {
          if (!silent) toast('Invalid master password.');
          updateSyncButtonState('error');
          return;
        }
        remoteContacts = await CryptoEngine.decrypt(payload);
      } else {
        remoteContacts = Array.isArray(payload) ? payload : payload.data;
      }

      if (Array.isArray(remoteContacts)) {
        window.state.contacts = mergeContactsLWW(window.state.contacts, remoteContacts);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state.contacts));
        renderDirectory();
      }
    }

    // 2. Push the merged result back up.
    const pwd = els.masterPasswordInput.value.trim();
    let uploadPayload;
    if (pwd) {
      if (!CryptoEngine.hasExistingVault()) await CryptoEngine.initializeVault(pwd);
      else if (!CryptoEngine.isUnlocked() && !(await CryptoEngine.unlockVault(pwd))) {
        if (!silent) toast('Invalid master password — synced local changes down, but could not push back up.');
        updateSyncButtonState('error');
        return;
      }
      uploadPayload = await CryptoEngine.encrypt(window.state.contacts);
      uploadPayload.encrypted = true;
    } else {
      uploadPayload = { v: 1, encrypted: false, data: window.state.contacts };
    }
    await GoogleDrive.uploadBackup(uploadPayload);

    window.state.dirty = false;
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    updateDriveUI();
    updateSyncButtonState('synced');
    if (!silent) toast('Synced with Google Drive.');
  } catch (err) {
    console.error(err);
    updateSyncButtonState('error');
    if (!silent) toast('Sync failed. Check console.');
  }
}

/**
 * Best-effort flush when the tab is about to disappear (closed, backgrounded,
 * navigated away). We can't reliably run the full download+merge+upload dance
 * during unload, and we deliberately skip this for encrypted vaults (an
 * in-flight WebCrypto operation racing a page teardown is worse than just
 * relying on the next visit's auto-sync). For the plain-JSON case, a fetch
 * with `keepalive: true` is used instead of sendBeacon, because keepalive
 * fetches (unlike sendBeacon) support the Authorization header Drive needs.
 * Local data itself is never at risk here — every edit already writes to
 * localStorage synchronously; this only covers the Drive backup.
 */
async function flushOnHide() {
  if (!window.state.dirty) return;
  if (!GoogleDrive.isSignedIn()) return;
  if (els.masterPasswordInput && els.masterPasswordInput.value.trim()) return; // encrypted: skip, too risky mid-unload
  try {
    await GoogleDrive.uploadBackup({ v: 1, encrypted: false, data: window.state.contacts }, { keepalive: true });
    window.state.dirty = false;
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch (e) {
    // best-effort only — nothing to do if this fails during teardown
  }
}

// --- Helpers ---
function isOverdue(c) {
  if (!c.frequencyGoalDays || !c.lastContactedAt) return false;
  return ((Date.now() - c.lastContactedAt) / 86400000) > c.frequencyGoalDays;
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setAIRingState(active, thinking = false) {
  if (!els.searchInputContainer) return;
  els.searchInputContainer.classList.toggle('ai-active', active);
  els.searchInputContainer.classList.toggle('ai-thinking', active && thinking);
}

// --- Semantic Worker System (embedding-based search; runs everywhere, no GPU needed) ---
function initSemanticWorker() {
  if (semanticWorker) return;
  try {
    semanticWorker = new Worker('./semantic-worker.js', { type: 'module' });
    semanticWorker.onmessage = (e) => {
      const { type, results, message } = e.data;
      if (type === 'index-complete') {
        if (els.aiStatus && window.state.aiSearchEnabled) els.aiStatus.textContent = 'AI Model Ready';
      } else if (type === 'query-result') {
        const q = window.state.searchQuery.toLowerCase();
        const ranked = results
          .map((r) => {
            const c = window.state.contacts.find((x) => x.id === r.id);
            let score = r.score;
            if (c && q) {
              const haystack = `${c.fullName} ${(c.tags || []).join(' ')} ${c.company || ''} ${c.jobTitle || ''} ${c.school || ''} ${c.notes || ''}`.toLowerCase();
              if (haystack.includes(q)) score += 0.15;
            }
            return { id: r.id, score };
          })
          .filter((r) => r.score > 0.22)
          .sort((a, b) => b.score - a.score);

        const matchingIds = new Set(ranked.map((r) => r.id));
        renderDirectoryWithFilter((c) => matchingIds.has(c.id), ranked.map((r) => r.id));
        setAIRingState(true, false);
        if (els.aiStatus) els.aiStatus.textContent = `Found ${matchingIds.size} semantic matches`;

        // If this looked like a genuine question rather than a keyword
        // search, hand the top matches to Local AI for a direct answer.
        maybeAskGemma(lastSemanticQueryText, ranked.slice(0, 8).map(r => r.id));
      } else if (type === 'error') {
        console.error("Worker error:", message);
        setAIRingState(true, false);
        if (els.aiStatus) els.aiStatus.textContent = 'AI Search error';
      }
    };
  } catch (err) {
    console.warn("Semantic worker initialization failed:", err);
  }
}

function indexSemanticSearch() {
  if (!semanticWorker) initSemanticWorker();
  if (!semanticWorker) return;

  const docs = window.state.contacts.filter(c => !c.isDeleted).map(c => {
    const relText = (c.relationships || [])
      .map(r => `${r.label} of ${window.state.contacts.find(t => t.id === r.targetContactId)?.fullName || ''}`)
      .join(', ');
    const handleText = (c.contactMethods || []).map(h => h.platform).join(' ');
    const customText = (c.customFields || []).filter(f => f.name && f.value).map(f => `${f.name}: ${f.value}`).join(', ');
    const parts = [
      `Name: ${c.fullName}${c.nickname ? ` (${c.nickname})` : ''}.`,
      c.jobTitle || c.company ? `Works as ${[c.jobTitle, c.company].filter(Boolean).join(' at ')}${c.department ? ` in ${c.department}` : ''}.` : '',
      c.school ? `Studied at ${c.school}.` : '',
      c.location ? `Located in ${c.location}.` : '',
      c.address ? `Address: ${[c.address.street, c.address.city, c.address.region, c.address.postalCode, c.address.country].filter(Boolean).join(', ')}.` : '',
      c.birthday ? `Birthday: ${c.birthday}.` : '',
      (c.tags || []).length ? `Tags: ${c.tags.join(', ')}.` : '',
      relText ? `Relationships: ${relText}.` : '',
      handleText ? `Reachable via: ${handleText}.` : '',
      customText ? `Other details: ${customText}.` : '',
      c.notes ? `Notes: ${c.notes}` : '',
    ];
    return { id: c.id, text: parts.filter(Boolean).join(' ') };
  });

  semanticWorker.postMessage({ type: 'index', payload: docs, requestId: Date.now() });
}

function toggleAISearchMode() {
  window.state.aiSearchEnabled = !window.state.aiSearchEnabled;
  if (els.aiToggleBtn) {
    els.aiToggleBtn.classList.toggle('active', window.state.aiSearchEnabled);
  }

  clearInterval(promptInterval);
  setAIRingState(window.state.aiSearchEnabled, false);

  if (window.state.aiSearchEnabled) {
    if (!semanticWorker) initSemanticWorker();
    indexSemanticSearch();
    if (els.aiStatus) els.aiStatus.textContent = "AI Search Mode Active";
    
    let promptIdx = 0;
    els.globalSearch.placeholder = EXAMPLE_PROMPTS[0];
    promptInterval = setInterval(() => {
      promptIdx = (promptIdx + 1) % EXAMPLE_PROMPTS.length;
      els.globalSearch.placeholder = EXAMPLE_PROMPTS[promptIdx];
    }, 3000);
  } else {
    els.globalSearch.placeholder = "Search names, notes, tags…";
    if (els.aiStatus) els.aiStatus.textContent = "";
    renderDirectory();
  }
}

function handleSearchInput() {
  const query = els.globalSearch.value.trim();
  window.state.searchQuery = query;

  if (!query) {
    renderDirectory();
    hideAIIsland();
    if (window.state.aiSearchEnabled) {
      setAIRingState(true, false);
      if (els.aiStatus) els.aiStatus.textContent = "AI Search Mode Active";
    }
    return;
  }

  if (window.state.aiSearchEnabled) {
    if (!semanticWorker) initSemanticWorker();
    setAIRingState(true, true);
    if (els.aiStatus) els.aiStatus.textContent = "Analyzing meanings...";
    lastSemanticQueryText = query;
    semanticWorker.postMessage({ type: 'query', payload: { text: query, topK: 30 }, requestId: Date.now() });
  } else {
    renderDirectory();
  }
}

// --- Item 9: dynamic-island answer popup for genuine questions ---
const QUESTION_PATTERN = /\?\s*$|^(who|what|when|where|why|how|is|are|does|do|can|should|which|count|list)\b/i;

function looksLikeQuestion(text) {
  return QUESTION_PATTERN.test(text.trim());
}

function showAIIsland(title) {
  if (!els.aiIsland) return;
  if (els.aiIslandTitle) els.aiIslandTitle.textContent = title || 'Local AI';
  els.aiIsland.hidden = false;
}
function hideAIIsland() {
  if (els.aiIsland) els.aiIsland.hidden = true;
}

let askInFlight = false;
async function maybeAskGemma(queryText, topContactIds) {
  if (!queryText || !looksLikeQuestion(queryText)) return;
  if (!window.GemmaAI) return;
  if (askInFlight) return;

  if (!gemmaCapability) gemmaCapability = await window.GemmaAI.detectCapability();
  if (!gemmaCapability.supported) {
    toast(`Local AI answers aren't available on this device: ${gemmaCapability.reason}`);
    return;
  }

  askInFlight = true;
  showAIIsland('Local AI — thinking…');
  if (els.aiIslandBody) els.aiIslandBody.textContent = 'Reading matching contacts…';

  try {
    if (!window.GemmaAI.isLoaded()) {
      if (els.aiIslandBody) els.aiIslandBody.textContent = 'Loading Local AI on this device (first time only)…';
      await window.GemmaAI.loadModel((pct) => {
        if (els.aiIslandBody) els.aiIslandBody.textContent = `Loading Local AI… ${pct}%`;
      });
    }

    const contacts = topContactIds
      .map(id => window.state.contacts.find(c => c.id === id))
      .filter(Boolean);
    const context = contacts.map(c => {
      const rels = (c.relationships || []).map(r => r.label).join(', ');
      return `${c.fullName} — tags: ${(c.tags||[]).join(', ') || 'none'}; relations: ${rels || 'none'}; notes: ${c.notes || 'none'}`;
    }).join('\n');

    if (els.aiIslandTitle) els.aiIslandTitle.textContent = 'Local AI';
    if (els.aiIslandBody) els.aiIslandBody.textContent = 'Thinking…';
    const answer = await window.GemmaAI.answerQuestion(queryText, context);
    if (els.aiIslandBody) els.aiIslandBody.textContent = answer || "I couldn't find that in your contacts.";
  } catch (err) {
    console.error(err);
    if (els.aiIslandBody) els.aiIslandBody.textContent = 'Something went wrong generating an answer on this device.';
  } finally {
    askInFlight = false;
  }
}

/** Kicked off right after login so the model is already warm by the time
 * someone turns on AI search, instead of eating a multi-second (or
 * multi-minute, on a slow connection) delay on first use. Shows progress in
 * a small label anchored under the AI toggle button, and keeps that button
 * disabled/greyed out for the whole download. */
async function preloadAIModel() {
  if (!window.GemmaAI || !els.aiToggleBtn) return;

  gemmaCapability = await window.GemmaAI.detectCapability();
  if (!gemmaCapability.supported) {
    els.aiToggleBtn.disabled = true;
    els.aiToggleBtn.classList.add('unavailable');
    els.aiToggleBtn.title = `AI search unavailable: ${gemmaCapability.reason}`;
    return;
  }

  els.aiToggleBtn.disabled = true;
  els.aiToggleBtn.classList.add('loading');
  if (els.aiModelStatus) { els.aiModelStatus.hidden = false; els.aiModelStatus.textContent = 'Loading AI model… 0%'; }

  try {
    await window.GemmaAI.loadModel((pct) => {
      if (els.aiModelStatus) els.aiModelStatus.textContent = `Loading AI model… ${pct}%`;
    });
    els.aiToggleBtn.disabled = false;
    els.aiToggleBtn.classList.remove('loading');
    if (els.aiModelStatus) {
      els.aiModelStatus.textContent = 'AI model ready';
      setTimeout(() => { if (els.aiModelStatus) els.aiModelStatus.hidden = true; }, 2500);
    }
  } catch (err) {
    console.error(err);
    els.aiToggleBtn.disabled = true;
    els.aiToggleBtn.classList.add('unavailable');
    els.aiToggleBtn.classList.remove('loading');
    if (els.aiModelStatus) els.aiModelStatus.textContent = 'AI model failed to load';
  }
}

async function initGemmaCapabilityUI() {
  if (!window.GemmaAI) return;
  gemmaCapability = await window.GemmaAI.detectCapability();
  if (els.aiCapabilityLine) {
    els.aiCapabilityLine.textContent = gemmaCapability.supported
      ? 'This device can run Local AI locally for direct question answering (ask a full question in AI search mode).'
      : `Not available on this device: ${gemmaCapability.reason} Semantic search still works normally.`;
  }
}

// --- Rendering ---
function populateFilterDropdowns() {
  const activeContacts = window.state.contacts.filter(c => !c.isDeleted);
  if (!els.filterSelect) return;

  const tags = Array.from(new Set(activeContacts.flatMap(c => c.tags || []))).sort((a, b) => a.localeCompare(b));
  const prev = window.state.filterValue;

  let html = '<option value="">All contacts</option>';
  if (tags.length) {
    html += `<optgroup label="Tag">${tags.map(t => `<option value="tag:${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}</optgroup>`;
  }
  if (activeContacts.length) {
    html += `<optgroup label="Related to">${activeContacts.map(c => `<option value="rel:${c.id}">${escapeHtml(c.fullName)}</option>`).join('')}</optgroup>`;
  }
  els.filterSelect.innerHTML = html;

  const stillValid = prev === '' ||
    (prev.startsWith('tag:') && tags.includes(prev.slice(4))) ||
    (prev.startsWith('rel:') && activeContacts.some(c => c.id === prev.slice(4)));
  if (stillValid) els.filterSelect.value = prev; else window.state.filterValue = '';
}

function renderDirectoryWithFilter(customFilter = null, rankedIds = null) {
  populateFilterDropdowns();
  let list = window.state.contacts.filter(c => !c.isDeleted);
  
  if (customFilter) {
    list = list.filter(customFilter);
  } else {
    const q = window.state.searchQuery.toLowerCase();
    if (q) list = list.filter(c => c.fullName?.toLowerCase().includes(q) || c.notes?.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q)));
    if (window.state.overdueOnly) list = list.filter(isOverdue);
    if (window.state.filterValue.startsWith('tag:')) {
      const tag = window.state.filterValue.slice(4);
      list = list.filter(c => (c.tags || []).includes(tag));
    } else if (window.state.filterValue.startsWith('rel:')) {
      const targetId = window.state.filterValue.slice(4);
      list = list.filter(c => (c.relationships || []).some(r => r.targetContactId === targetId));
    }
  }
  
  if (rankedIds) {
    const rank = new Map(rankedIds.map((id, i) => [id, i]));
    list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  } else {
    list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  
  if (els.resultCount) els.resultCount.textContent = `${list.length} contacts`;
  if (els.contactGrid) els.contactGrid.innerHTML = '';
  if (els.emptyState) els.emptyState.hidden = list.length > 0;

  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    
    const pfpHtml = c.pfpBase64 
        ? `<img src="${c.pfpBase64}" style="width:100%;height:100%;object-fit:cover;">` 
        : initials(c.fullName);

    const primaryHandle = (c.contactMethods || []).find(h => h.value?.trim());
    const subtitle = [c.jobTitle, c.company].filter(Boolean).join(' at ') || c.school || c.location || '';

    card.innerHTML = `
      <div class="card-top">
        <div class="card-pfp" style="overflow:hidden;">${pfpHtml}</div>
        <div>
          <div class="card-name">${escapeHtml(c.fullName)}</div>
          ${subtitle ? `<div class="card-handles">${escapeHtml(subtitle)}</div>` : (primaryHandle ? `<div class="card-handles">${escapeHtml(primaryHandle.value)}</div>` : '')}
        </div>
      </div>
      <div class="card-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-bottom">
        ${isOverdue(c) ? `<span class="last-contact-badge overdue-amber">Overdue</span>` : '<span></span>'}
        <button type="button" class="btn btn-secondary log-btn" data-log-id="${c.id}">Log</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-log-id]')) return;
      openContactModal(c.id);
    });
    card.querySelector('[data-log-id]').addEventListener('click', () => openInteractionModal(c.id));
    if (els.contactGrid) els.contactGrid.appendChild(card);
  }
}

function renderDirectory() {
  renderDirectoryWithFilter(null);
  renderReports();
  renderMergeSuggestions();
}

// --- Reports ---
function renderReports() {
  const activeContacts = window.state.contacts.filter(c => !c.isDeleted);

  if (els.reportOverdue) {
    const overdue = activeContacts.filter(isOverdue).sort((a, b) => {
      const daysA = (Date.now() - a.lastContactedAt) / 86400000 - a.frequencyGoalDays;
      const daysB = (Date.now() - b.lastContactedAt) / 86400000 - b.frequencyGoalDays;
      return daysB - daysA;
    });
    els.reportOverdue.innerHTML = overdue.length
      ? overdue.map(c => {
          const daysSince = Math.floor((Date.now() - c.lastContactedAt) / 86400000);
          return `<div class="report-row"><span>${escapeHtml(c.fullName)}</span><span>${daysSince}d since last contact (goal: ${c.frequencyGoalDays}d)</span></div>`;
        }).join('')
      : '<p class="report-hint">Nobody is overdue for a reconnect. 🎉</p>';
  }

  if (els.reportTags) {
    const counts = {};
    activeContacts.forEach(c => (c.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    els.reportTags.innerHTML = entries.length
      ? entries.map(([tag, count]) => `<div class="report-row"><span>${escapeHtml(tag)}</span><span>${count}</span></div>`).join('')
      : '<p class="report-hint">No tags yet.</p>';
  }
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportRawJson() {
  const active = window.state.contacts.filter(c => !c.isDeleted);
  downloadFile('rolodex_export.json', JSON.stringify(active, null, 2), 'application/json');
  toast('Exported JSON.');
}

function exportCsv() {
  const active = window.state.contacts.filter(c => !c.isDeleted);
  const header = ['Full Name', 'Nickname', 'Middle Name', 'Company', 'Job Title', 'Department', 'School', 'Website', 'Birthday', 'Location', 'Address', 'Tags', 'Notes', 'Contact Methods', 'Custom Fields', 'Last Contacted'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = active.map(c => [
    c.fullName || '',
    c.nickname || '',
    c.middleName || '',
    c.company || '',
    c.jobTitle || '',
    c.department || '',
    c.school || '',
    c.website || '',
    c.birthday || '',
    c.location || '',
    c.address ? [c.address.street, c.address.city, c.address.region, c.address.postalCode, c.address.country].filter(Boolean).join(', ') : '',
    (c.tags || []).join('; '),
    c.notes || '',
    (c.contactMethods || []).map(h => h.value).join('; '),
    (c.customFields || []).filter(f => f.name || f.value).map(f => `${f.name}: ${f.value}`).join('; '),
    c.lastContactedAt ? new Date(c.lastContactedAt).toISOString() : '',
  ].map(csvEscape).join(','));
  const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
  downloadFile('rolodex_export.csv', csv, 'text/csv');
  toast('Exported CSV.');
}

// --- PFP Logic ---
function updatePfpUI() {
  if (window.state.pendingPfpBase64) {
    if (els.pfpImg) { els.pfpImg.src = window.state.pendingPfpBase64; els.pfpImg.hidden = false; }
    if (els.pfpInitial) els.pfpInitial.hidden = true;
    if (els.removePfpBtn) els.removePfpBtn.hidden = false;
  } else {
    if (els.pfpImg) els.pfpImg.hidden = true;
    if (els.pfpInitial) { els.pfpInitial.hidden = false; els.pfpInitial.textContent = initials(els.fullNameInput?.value || '?'); }
    if (els.removePfpBtn) els.removePfpBtn.hidden = true;
  }
}

// --- Merge Contacts System ---
function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Heuristic duplicate detection — every pair of active contacts is scored
 * on name closeness plus any exact-matching phone/email, and the strongest
 * matches are surfaced as one-click merge suggestions instead of requiring
 * the person to manually hunt for duplicates in a dropdown. */
function findDuplicateSuggestions() {
  const active = window.state.contacts.filter(c => !c.isDeleted);
  const suggestions = [];

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const key = [a.id, b.id].sort().join('|');
      if (window.state.dismissedMergePairs.has(key)) continue;

      const nameA = normalizeName(a.fullName), nameB = normalizeName(b.fullName);
      const reasons = [];
      let score = 0;

      if (nameA && nameA === nameB) { score += 0.7; reasons.push('same name'); }
      else if (nameA && nameB) {
        const dist = levenshtein(nameA, nameB);
        const maxLen = Math.max(nameA.length, nameB.length);
        if (maxLen > 0 && dist / maxLen <= 0.15) { score += 0.4; reasons.push('very similar name'); }
      }

      const methodsA = (a.contactMethods || []).map(m => m.value?.trim().toLowerCase()).filter(Boolean);
      const methodsB = (b.contactMethods || []).map(m => m.value?.trim().toLowerCase()).filter(Boolean);
      const sharedMethod = methodsA.find(m => methodsB.includes(m));
      if (sharedMethod) { score += 0.5; reasons.push('same phone/email'); }

      if (a.company && b.company && a.company.trim().toLowerCase() === b.company.trim().toLowerCase()
          && a.jobTitle && b.jobTitle && a.jobTitle.trim().toLowerCase() === b.jobTitle.trim().toLowerCase()) {
        score += 0.2; reasons.push('same company & role');
      }

      if (score >= 0.5) {
        suggestions.push({ a, b, score, reasons, key });
      }
    }
  }

  return suggestions.sort((x, y) => y.score - x.score).slice(0, 5);
}

function renderMergeSuggestions() {
  if (!els.mergeSuggestions) return;
  const suggestions = findDuplicateSuggestions();

  if (els.mergeAllBtn) els.mergeAllBtn.disabled = suggestions.length === 0;

  if (!suggestions.length) { els.mergeSuggestions.innerHTML = ''; return; }

  els.mergeSuggestions.innerHTML = suggestions.map(s => `
    <div class="merge-suggestion-card" data-key="${s.key}">
      <div class="merge-suggestion-text">
        <strong>${escapeHtml(s.a.fullName)}</strong> and <strong>${escapeHtml(s.b.fullName)}</strong> look like the same person
        <span class="merge-suggestion-reason">${escapeHtml(s.reasons.join(', '))}</span>
      </div>
      <div class="merge-suggestion-actions">
        <button type="button" class="btn btn-primary btn-small" data-quick-merge="${s.a.id}|${s.b.id}">Merge</button>
        <button type="button" class="btn btn-ghost btn-small" data-dismiss-suggestion="${s.key}">Dismiss</button>
      </div>
    </div>
  `).join('');

  els.mergeSuggestions.querySelectorAll('[data-quick-merge]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [pId, sId] = btn.dataset.quickMerge.split('|');
      executeMergeContacts(pId, sId);
    });
  });
  els.mergeSuggestions.querySelectorAll('[data-dismiss-suggestion]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.state.dismissedMergePairs.add(btn.dataset.dismissSuggestion);
      renderMergeSuggestions();
    });
  });
}

function openMergeModal() {
  const activeContacts = window.state.contacts.filter(c => !c.isDeleted);
  if (activeContacts.length < 2) return toast("Need at least 2 contacts to merge.");

  const options = activeContacts.map(c => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
  els.mergePrimarySelect.innerHTML = options;
  els.mergeSecondarySelect.innerHTML = options;
  if (activeContacts.length > 1) els.mergeSecondarySelect.selectedIndex = 1;

  els.mergeModal.hidden = false;
}

/** Core merge logic, shared by the manual merge modal and the one-click
 * auto-merge suggestions above. */
function executeMergeContacts(pId, sId, opts = {}) {
  const silent = !!opts.silent;
  if (pId === sId) { if (!silent) toast("Primary and secondary contact must be different."); return; }

  const primary = window.state.contacts.find(c => c.id === pId);
  const secondary = window.state.contacts.find(c => c.id === sId);
  if (!primary || !secondary) return;

  primary.tags = Array.from(new Set([...(primary.tags || []), ...(secondary.tags || [])]));
  primary.contactMethods = [...(primary.contactMethods || []), ...(secondary.contactMethods || [])];
  primary.interactions = [...(primary.interactions || []), ...(secondary.interactions || [])];
  primary.relationships = [...(primary.relationships || []), ...(secondary.relationships || [])]
    .filter(r => r.targetContactId !== pId && r.targetContactId !== sId);
  primary.pfpBase64 = primary.pfpBase64 || secondary.pfpBase64;
  if (!primary.frequencyGoalDays && secondary.frequencyGoalDays) {
    primary.frequencyGoalValue = secondary.frequencyGoalValue;
    primary.frequencyGoalUnit = secondary.frequencyGoalUnit;
    primary.frequencyGoalDays = secondary.frequencyGoalDays;
  }
  if (primary.interactions.length) {
    primary.lastContactedAt = Math.max(...primary.interactions.map(i => i.date));
  }

  if (secondary.notes) {
    primary.notes = (primary.notes ? primary.notes + '\n\n' : '') + `[Merged Note from ${secondary.fullName}]:\n` + secondary.notes;
  }

  window.state.contacts.forEach(c => {
    if (c.id === pId || c.id === sId || !c.relationships) return;
    c.relationships = c.relationships
      .map(r => r.targetContactId === sId ? { ...r, targetContactId: pId } : r)
      .filter(r => r.targetContactId !== c.id);
  });

  primary.updatedAt = Date.now();
  secondary.isDeleted = true;
  secondary.updatedAt = Date.now();

  if (!silent) {
    saveAllToStorage();
    renderDirectory();
    if (els.mergeModal) els.mergeModal.hidden = true;
    toast(`Merged ${secondary.fullName} into ${primary.fullName}`);
  }
}

/** Merges every currently-suggested duplicate pair in one go. Recomputes
 * suggestions after each merge (ids shift as contacts get marked deleted),
 * with a safety cap so a scoring quirk can never loop forever. */
function mergeAllSuggested() {
  let suggestions = findDuplicateSuggestions();
  if (!suggestions.length) { toast('No duplicate suggestions to merge.'); return; }

  let count = 0;
  const safetyCap = 200;
  while (suggestions.length && count < safetyCap) {
    const s = suggestions[0];
    executeMergeContacts(s.a.id, s.b.id, { silent: true });
    count++;
    suggestions = findDuplicateSuggestions();
  }

  saveAllToStorage();
  renderDirectory();
  toast(`Merged ${count} duplicate pair${count === 1 ? '' : 's'}.`);
}

// --- Modals ---
function openContactModal(id) {
  const contact = id ? window.state.contacts.find((c) => c.id === id) : null;
  if (els.contactModalTitle) els.contactModalTitle.textContent = contact ? 'Edit contact' : 'New contact';
  if (els.contactId) els.contactId.value = id || '';
  if (els.fullNameInput) els.fullNameInput.value = contact?.fullName || '';
  if (els.tagsInput) els.tagsInput.value = (contact?.tags || []).join(', ');
  
  if (els.frequencyInput) els.frequencyInput.value = contact?.frequencyGoalValue ?? '';
  if (els.frequencyUnitInput) els.frequencyUnitInput.value = contact?.frequencyGoalUnit ?? 'days';

  if (els.companyInput) els.companyInput.value = contact?.company || '';
  if (els.jobTitleInput) els.jobTitleInput.value = contact?.jobTitle || '';
  if (els.schoolInput) els.schoolInput.value = contact?.school || '';
  if (els.locationInput) els.locationInput.value = contact?.location || '';

  if (els.nicknameInput) els.nicknameInput.value = contact?.nickname || '';
  if (els.middleNameInput) els.middleNameInput.value = contact?.middleName || '';
  if (els.departmentInput) els.departmentInput.value = contact?.department || '';
  if (els.websiteInput) els.websiteInput.value = contact?.website || '';
  if (els.birthdayInput) els.birthdayInput.value = contact?.birthday || '';
  if (els.addressStreetInput) els.addressStreetInput.value = contact?.address?.street || '';
  if (els.addressCityInput) els.addressCityInput.value = contact?.address?.city || '';
  if (els.addressRegionInput) els.addressRegionInput.value = contact?.address?.region || '';
  if (els.addressPostalInput) els.addressPostalInput.value = contact?.address?.postalCode || '';
  if (els.addressCountryInput) els.addressCountryInput.value = contact?.address?.country || '';

  if (els.notesInput) els.notesInput.value = contact?.notes || '';
  if (els.deleteContactBtn) els.deleteContactBtn.hidden = !contact;

  window.state.pendingPfpBase64 = contact?.pfpBase64 || null;
  updatePfpUI();

  window.state.handleRowsDraft = contact ? JSON.parse(JSON.stringify(contact.contactMethods || [])) : [];
  window.state.customFieldsDraft = contact ? JSON.parse(JSON.stringify(contact.customFields || [])) : [];
  window.state.relationRowsDraft = contact ? JSON.parse(JSON.stringify(contact.relationships || [])) : [];
  window.state.interactionsDraft = contact ? JSON.parse(JSON.stringify(contact.interactions || [])) : [];

  renderHandleRows(); renderCustomFieldRows(); renderRelationRows(); renderInteractionList();
  if (els.relationSearchInput) els.relationSearchInput.value = '';
  if (els.relationSearchResults) { els.relationSearchResults.hidden = true; els.relationSearchResults.innerHTML = ''; }
  if (els.contactModal) els.contactModal.hidden = false;
}

function saveContactFromModal() {
  const id = els.contactId.value || uuid();
  const fullName = els.fullNameInput.value.trim();
  if (!fullName) return toast('Name required.');

  const freqVal = els.frequencyInput.value ? Number(els.frequencyInput.value) : undefined;
  const freqUnit = els.frequencyUnitInput.value;
  let computedDays = undefined;
  if (freqVal) {
    if (freqUnit === 'weeks') computedDays = freqVal * 7;
    else if (freqUnit === 'months') computedDays = freqVal * 30;
    else computedDays = freqVal;
  }

  const contact = {
    id, fullName,
    pfpBase64: window.state.pendingPfpBase64,
    frequencyGoalValue: freqVal,
    frequencyGoalUnit: freqUnit,
    frequencyGoalDays: computedDays,
    company: els.companyInput?.value.trim() || undefined,
    jobTitle: els.jobTitleInput?.value.trim() || undefined,
    school: els.schoolInput?.value.trim() || undefined,
    location: els.locationInput?.value.trim() || undefined,
    nickname: els.nicknameInput?.value.trim() || undefined,
    middleName: els.middleNameInput?.value.trim() || undefined,
    department: els.departmentInput?.value.trim() || undefined,
    website: els.websiteInput?.value.trim() || undefined,
    birthday: els.birthdayInput?.value || undefined,
    address: (() => {
      const street = els.addressStreetInput?.value.trim() || '';
      const city = els.addressCityInput?.value.trim() || '';
      const region = els.addressRegionInput?.value.trim() || '';
      const postalCode = els.addressPostalInput?.value.trim() || '';
      const country = els.addressCountryInput?.value.trim() || '';
      return (street || city || region || postalCode || country) ? { street, city, region, postalCode, country } : undefined;
    })(),
    lastContactedAt: window.state.interactionsDraft.length ? Math.max(...window.state.interactionsDraft.map(i => i.date)) : undefined,
    contactMethods: window.state.handleRowsDraft.filter((h) => h.value.trim()),
    customFields: window.state.customFieldsDraft.filter((f) => f.name.trim() || f.value.trim()),
    relationships: window.state.relationRowsDraft,
    tags: els.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
    notes: els.notesInput.value,
    interactions: window.state.interactionsDraft,
    updatedAt: Date.now(),
    isDeleted: false,
  };

  const idx = window.state.contacts.findIndex((c) => c.id === id);
  if (idx >= 0) window.state.contacts[idx] = contact; else window.state.contacts.push(contact);

  syncReciprocalRelationships(contact);

  saveAllToStorage(); renderDirectory();
  els.contactModal.hidden = true;
  if (window.state.activeView === 'network' && window.renderNetworkMap) window.renderNetworkMap(window.state.contacts);
}

function syncReciprocalRelationships(contact) {
  const linkedIds = new Set((contact.relationships || []).map(r => r.targetContactId));

  linkedIds.forEach(targetId => {
    const target = window.state.contacts.find(c => c.id === targetId && !c.isDeleted);
    if (!target) return;
    target.relationships = target.relationships || [];
    const relFromContact = contact.relationships.find(r => r.targetContactId === targetId);
    const alreadyLinked = target.relationships.some(r => r.targetContactId === contact.id);
    if (!alreadyLinked) {
      target.relationships.push({ targetContactId: contact.id, label: relFromContact.label });
      target.updatedAt = Date.now();
    }
  });
}

const HANDLE_PLATFORMS = ['phone', 'email', 'whatsapp', 'discord', 'instagram', 'snapchat', 'telegram', 'signal', 'linkedin', 'x', 'facebook', 'other'];

function renderHandleRows() {
  if(!els.handleRows) return;
  els.handleRows.innerHTML = window.state.handleRowsDraft.map((h, idx) => `
    <div class="dynamic-row" data-idx="${idx}">
      <select class="select handle-platform" data-idx="${idx}">
        ${HANDLE_PLATFORMS.map(p => `<option value="${p}" ${h.platform === p ? 'selected' : ''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}
      </select>
      <input class="input handle-input" data-idx="${idx}" value="${escapeHtml(h.value)}" placeholder="Value">
      <button type="button" class="row-remove btn btn-ghost" data-remove-handle="${idx}">&times;</button>
    </div>`).join('');
  els.handleRows.querySelectorAll('.handle-input').forEach(el => el.addEventListener('input', e => window.state.handleRowsDraft[e.target.dataset.idx].value = e.target.value));
  els.handleRows.querySelectorAll('.handle-platform').forEach(el => el.addEventListener('change', e => window.state.handleRowsDraft[e.target.dataset.idx].platform = e.target.value));
  els.handleRows.querySelectorAll('[data-remove-handle]').forEach(btn => btn.addEventListener('click', () => { window.state.handleRowsDraft.splice(+btn.dataset.removeHandle, 1); renderHandleRows(); }));
}

/** User-defined fields: a contact-specific name (e.g. "Blood type", "Favorite
 * coffee order") paired with a value, for anything the built-in fields don't
 * cover. Stored per-contact as customFields: [{id, name, value}]. */
function renderCustomFieldRows() {
  if (!els.customFieldRows) return;
  els.customFieldRows.innerHTML = window.state.customFieldsDraft.map((f, idx) => `
    <div class="dynamic-row" data-idx="${idx}">
      <input class="input custom-field-name" data-idx="${idx}" value="${escapeHtml(f.name)}" placeholder="Field name (e.g. Blood type)" style="flex:0 0 180px;">
      <input class="input custom-field-value" data-idx="${idx}" value="${escapeHtml(f.value)}" placeholder="Value">
      <button type="button" class="row-remove btn btn-ghost" data-remove-custom="${idx}">&times;</button>
    </div>`).join('');
  els.customFieldRows.querySelectorAll('.custom-field-name').forEach(el => el.addEventListener('input', e => { window.state.customFieldsDraft[+e.target.dataset.idx].name = e.target.value; }));
  els.customFieldRows.querySelectorAll('.custom-field-value').forEach(el => el.addEventListener('input', e => { window.state.customFieldsDraft[+e.target.dataset.idx].value = e.target.value; }));
  els.customFieldRows.querySelectorAll('[data-remove-custom]').forEach(btn => btn.addEventListener('click', () => { window.state.customFieldsDraft.splice(+btn.dataset.removeCustom, 1); renderCustomFieldRows(); }));
}

function renderRelationRows() {
  if(!els.relationRows) return;
  els.relationRows.innerHTML = window.state.relationRowsDraft.map((r, idx) => {
    const target = window.state.contacts.find(c => c.id === r.targetContactId);
    const targetName = target ? target.fullName : '(deleted contact)';
    return `
    <div class="dynamic-row">
      <span style="flex:0 0 auto; font-size:13.5px; white-space:nowrap;">${escapeHtml(targetName)}</span>
      <input type="text" class="input relation-row-label" data-relation-label-idx="${idx}" value="${escapeHtml(r.label)}" placeholder="Label, e.g. Sister">
      <button type="button" class="row-remove btn btn-ghost" data-remove-relation="${idx}" title="Remove link">&times;</button>
    </div>`;
  }).join('');
  els.relationRows.querySelectorAll('[data-relation-label-idx]').forEach(el => el.addEventListener('input', e => {
    window.state.relationRowsDraft[+e.target.dataset.relationLabelIdx].label = e.target.value;
  }));
  els.relationRows.querySelectorAll('[data-remove-relation]').forEach(btn => btn.addEventListener('click', () => { window.state.relationRowsDraft.splice(+btn.dataset.removeRelation, 1); renderRelationRows(); }));
}

/** Mini search-as-you-type box for linking relationships: click a name and
 * it's linked immediately (added to the draft that gets saved with the
 * contact) — no separate "+Link" button to press. */
function renderRelationSearchResults(query) {
  if (!els.relationSearchResults) return;
  const currentId = els.contactId ? els.contactId.value : '';
  const linkedIds = new Set(window.state.relationRowsDraft.map(r => r.targetContactId));
  const q = query.trim().toLowerCase();

  if (!q) { els.relationSearchResults.hidden = true; els.relationSearchResults.innerHTML = ''; return; }

  const matches = window.state.contacts
    .filter(c => !c.isDeleted && c.id !== currentId && !linkedIds.has(c.id) && c.fullName?.toLowerCase().includes(q))
    .slice(0, 8);

  els.relationSearchResults.innerHTML = matches.length
    ? matches.map(c => `<div class="relation-search-result" data-link-id="${c.id}">${escapeHtml(c.fullName)}</div>`).join('')
    : `<div class="relation-search-empty">No matching contacts.</div>`;
  els.relationSearchResults.hidden = false;

  els.relationSearchResults.querySelectorAll('[data-link-id]').forEach(row => {
    row.addEventListener('click', () => {
      window.state.relationRowsDraft.push({ targetContactId: row.dataset.linkId, label: '' });
      renderRelationRows();
      els.relationSearchInput.value = '';
      els.relationSearchResults.hidden = true;
      els.relationSearchResults.innerHTML = '';
      // Focus the freshly-added row's label input so a label can be typed right away.
      const idx = window.state.relationRowsDraft.length - 1;
      const labelEl = els.relationRows.querySelector(`[data-relation-label-idx="${idx}"]`);
      if (labelEl) labelEl.focus();
    });
  });
}

function renderInteractionList() {
  if(!els.interactionList) return;
  els.interactionList.innerHTML = [...window.state.interactionsDraft].sort((a,b) => b.date - a.date).map(i => `
    <div class="interaction-item" style="border:1px solid #e2e8f0; padding:8px; border-radius:6px; margin-bottom:6px;">
      <div class="interaction-meta"><strong>${escapeHtml(i.channel)}</strong></div>
      <div class="interaction-summary">${escapeHtml(i.summary)}</div>
      <div class="interaction-actions">
        <button class="btn btn-secondary btn-small" data-edit-i="${i.id}">Edit</button>
        <button class="btn btn-danger btn-small" data-delete-i="${i.id}">Delete</button>
      </div>
    </div>`).join('');
  els.interactionList.querySelectorAll('[data-edit-i]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); const i = window.state.interactionsDraft.find(x => x.id === b.dataset.editI); const s = prompt("Edit:", i.summary); if(s !== null) { i.summary = s; renderInteractionList(); }}));
  els.interactionList.querySelectorAll('[data-delete-i]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); if(confirm("Delete?")) { window.state.interactionsDraft = window.state.interactionsDraft.filter(x => x.id !== b.dataset.deleteI); renderInteractionList(); }}));
}

function openInteractionModal(contactId) { els.quickInteractionContactId.value = contactId; els.interactionModal.hidden = false; }
function saveQuickInteraction() {
  const contact = window.state.contacts.find((c) => c.id === els.quickInteractionContactId.value);
  if (!contact) return;
  const now = Date.now();
  contact.interactions = contact.interactions || [];
  contact.interactions.push({ id: uuid(), date: now, channel: els.quickChannelInput.value || 'Touchpoint', summary: els.quickSummaryInput.value });
  contact.lastContactedAt = Math.max(contact.lastContactedAt || 0, now);
  contact.updatedAt = now;
  saveAllToStorage(); renderDirectory(); els.interactionModal.hidden = true;
  els.quickChannelInput.value = ''; els.quickSummaryInput.value = '';
  toast(`Logged interaction with ${contact.fullName}.`);
}

// --- Process Imported vCards (folds straight into the same synced contact list) ---
function processVCardFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { 
    try {
      const parsed = VCardParser.parse(ev.target.result);
      if (!parsed || parsed.length === 0) throw new Error("No contacts found in vCard file.");
      parsed.forEach(c => { c.id = uuid(); c.updatedAt = Date.now(); c.isDeleted = false; window.state.contacts.push(c); });
      saveAllToStorage(); renderDirectory();
      toast(GoogleDrive.isSignedIn()
        ? `Imported ${parsed.length} contact(s) — will go up on next sync.`
        : `Imported ${parsed.length} contact(s)!`);
    } catch (err) { console.error(err); toast("Failed to parse vCard file."); }
  };
  reader.readAsText(file);
}

// --- Login screen ---
// Gates the app behind Google sign-in — no separate local password to
// create or remember. Signing in both grants access and connects Drive
// sync in one step, since the whole point is "it all goes through Google".
// A quiet "continue without signing in" escape hatch is kept for people who
// aren't ready to connect Google yet (matches the README's offline mode);
// the app still works local-only in that case.
let appInitialized = false;

async function initLockScreen() {
  if (els.googleLoginBtn) els.googleLoginBtn.addEventListener('click', handleGoogleLogin);
  if (els.continueOfflineBtn) els.continueOfflineBtn.addEventListener('click', () => unlockApp());

  // If we've connected before, try to resume the Google session silently and
  // skip the login screen entirely rather than making a returning person
  // click "Sign in with Google" again every visit.
  if (localStorage.getItem(DRIVE_CONNECTED_KEY) === 'true') {
    if (els.googleLoginBtn) { els.googleLoginBtn.disabled = true; els.googleLoginBtn.textContent = 'Signing in…'; }
    for (let i = 0; i < 20 && typeof google === 'undefined'; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const ok = await GoogleDrive.trySilentSignIn().catch(() => false);
    if (ok) {
      unlockApp();
      await runFullSync({ silent: true });
      await maybeShowWelcomeImport();
      return;
    }
    if (els.googleLoginBtn) { els.googleLoginBtn.disabled = false; els.googleLoginBtn.textContent = 'Sign in with Google'; }
  }
}

async function handleGoogleLogin() {
  if (els.lockGoogleError) els.lockGoogleError.hidden = true;
  if (!GoogleDrive.isConfigured()) {
    if (els.lockGoogleError) { els.lockGoogleError.textContent = 'Google sign-in is not configured for this deployment yet — you can continue without it below.'; els.lockGoogleError.hidden = false; }
    return;
  }
  els.googleLoginBtn.disabled = true;
  try {
    await GoogleDrive.signIn();
    localStorage.setItem(DRIVE_CONNECTED_KEY, 'true');
    unlockApp();
    toast('Signed in with Google!');
    await runFullSync();
    await maybeShowWelcomeImport();
  } catch (err) {
    console.error(err);
    if (els.lockGoogleError) { els.lockGoogleError.textContent = 'Google sign-in failed: ' + err.message; els.lockGoogleError.hidden = false; }
  } finally {
    els.googleLoginBtn.disabled = false;
  }
}

function unlockApp() {
  if (els.lockScreen) els.lockScreen.hidden = true;
  if (els.appShell) els.appShell.hidden = false;
  initApp();
  preloadAIModel();
}

// --- Init & Events ---
function initApp() {
  if (appInitialized) return;
  appInitialized = true;

  loadAllFromStorage(); renderDirectory();
  initGemmaCapabilityUI();

  if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => { els.settingsModal.hidden = false; });
  if (els.wipeLocalBtn) els.wipeLocalBtn.addEventListener('click', () => {
    if(!confirm("Erase EVERYTHING?")) return;
    localStorage.removeItem(STORAGE_KEY); window.state.contacts = [];
    renderDirectory(); els.settingsModal.hidden = true; toast("Erased.");
  });

  // Search & AI Toggle
  if (els.globalSearch) {
    els.globalSearch.addEventListener('input', handleSearchInput);
    els.globalSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && window.state.aiSearchEnabled && window.state.searchQuery) {
        lastSemanticQueryText = window.state.searchQuery;
        maybeAskGemma(window.state.searchQuery, window.state.contacts.filter(c => !c.isDeleted).slice(0, 8).map(c => c.id));
      }
    });
  }
  if (els.aiToggleBtn) els.aiToggleBtn.addEventListener('click', toggleAISearchMode);
  if (els.aiIslandClose) els.aiIslandClose.addEventListener('click', hideAIIsland);

  // Filter bar (single combined filter + overdue toggle)
  if (els.filterSelect) els.filterSelect.addEventListener('change', () => { window.state.filterValue = els.filterSelect.value; renderDirectory(); });
  if (els.overdueFilterBtn) els.overdueFilterBtn.addEventListener('click', () => {
    window.state.overdueOnly = !window.state.overdueOnly;
    els.overdueFilterBtn.dataset.active = String(window.state.overdueOnly);
    renderDirectory();
  });

  // Export
  if (els.exportRawBtn) els.exportRawBtn.addEventListener('click', exportRawJson);
  if (els.exportCsvBtn) els.exportCsvBtn.addEventListener('click', exportCsv);

  // Google Drive — one unified Sync action, in both the header button and the Sync tab
  updateDriveUI();
  updateSyncButtonState();
  if (els.gdriveLoginBtn) els.gdriveLoginBtn.addEventListener('click', async () => {
    if (GoogleDrive.isSignedIn()) {
      if (!confirm('Disconnect Google Drive? Your local contacts stay right where they are.')) return;
      GoogleDrive.signOut();
      localStorage.removeItem(DRIVE_CONNECTED_KEY);
      updateDriveUI();
      toast('Disconnected from Google Drive.');
      return;
    }
    try {
      await GoogleDrive.signIn();
      localStorage.setItem(DRIVE_CONNECTED_KEY, 'true');
      updateDriveUI();
      toast('Logged into Google Drive!');
      await runFullSync();
    } catch (e) { toast('Drive login failed: ' + e.message); console.error(e); }
  });
  if (els.gdriveSyncBtn) els.gdriveSyncBtn.addEventListener('click', () => runFullSync());
  if (els.syncBtn) els.syncBtn.addEventListener('click', () => {
    if (!GoogleDrive.isSignedIn()) { els.settingsModal.hidden = true; document.querySelector('[data-view="import"]').click(); toast('Connect Google Drive first, on the Sync tab.'); return; }
    runFullSync();
  });

  // Best-effort save-before-close (see flushOnHide for what this can and can't do)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnHide(); });
  window.addEventListener('pagehide', flushOnHide);

  // Merge Feature Handlers
  if (els.mergeContactsBtn) els.mergeContactsBtn.addEventListener('click', openMergeModal);
  if (els.mergeAllBtn) els.mergeAllBtn.addEventListener('click', mergeAllSuggested);
  if (els.confirmMergeBtn) els.confirmMergeBtn.addEventListener('click', () => executeMergeContacts(els.mergePrimarySelect.value, els.mergeSecondarySelect.value));

  // vCard File Upload & Dropzone Handlers
  if (els.triggerVcfBtn) els.triggerVcfBtn.addEventListener('click', (e) => { e.stopPropagation(); els.vcfInput.click(); });
  if (els.vcfInput) els.vcfInput.addEventListener('change', (e) => processVCardFile(e.target.files[0]));
  if (els.dropZone) {
    els.dropZone.addEventListener('click', () => els.vcfInput.click());
    els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag-over'); });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag-over'));
    els.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) processVCardFile(e.dataTransfer.files[0]);
    });
  }

  // Profile Photo Reader
  if (els.pfpInput) els.pfpInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { window.state.pendingPfpBase64 = ev.target.result; updatePfpUI(); };
    reader.readAsDataURL(file);
  });
  if (els.removePfpBtn) els.removePfpBtn.addEventListener('click', () => { window.state.pendingPfpBase64 = null; updatePfpUI(); els.pfpInput.value = ''; });
  if (els.fullNameInput) els.fullNameInput.addEventListener('input', updatePfpUI);

  // Navigation Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab, .view').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
      window.state.activeView = tab.dataset.view;
      if (tab.dataset.view === 'network' && window.renderNetworkMap) window.renderNetworkMap(window.state.contacts);
      else if (window.stopNetworkMap) window.stopNetworkMap();
    });
  });

  // Modal Buttons
  if (els.addContactBtn) els.addContactBtn.addEventListener('click', () => openContactModal(null));
  if (els.saveContactBtn) els.saveContactBtn.addEventListener('click', saveContactFromModal);
  if (els.addHandleBtn) els.addHandleBtn.addEventListener('click', () => { window.state.handleRowsDraft.push({ platform: 'phone', value: '' }); renderHandleRows(); });
  if (els.addCustomFieldBtn) els.addCustomFieldBtn.addEventListener('click', () => { window.state.customFieldsDraft.push({ id: uuid(), name: '', value: '' }); renderCustomFieldRows(); });
  if (els.relationSearchInput) {
    els.relationSearchInput.addEventListener('input', (e) => renderRelationSearchResults(e.target.value));
    els.relationSearchInput.addEventListener('focus', (e) => { if (e.target.value.trim()) renderRelationSearchResults(e.target.value); });
    document.addEventListener('click', (e) => {
      if (els.relationSearchResults && !els.relationSearchResults.hidden &&
          !els.relationSearchResults.contains(e.target) && e.target !== els.relationSearchInput) {
        els.relationSearchResults.hidden = true;
      }
    });
  }
  if (els.addInteractionBtn) els.addInteractionBtn.addEventListener('click', () => { window.state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: 'Note', summary: '' }); renderInteractionList(); });
  if (els.saveQuickInteractionBtn) els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);
  if (els.deleteContactBtn) els.deleteContactBtn.addEventListener('click', () => {
    if (!confirm('Delete?')) return;
    const deletedId = els.contactId.value;
    const deleted = window.state.contacts.find(c => c.id === deletedId);
    if (!deleted) return;
    deleted.isDeleted = true;
    deleted.updatedAt = Date.now();
    window.state.contacts.forEach(c => {
      if (c.id === deletedId || !c.relationships) return;
      const before = c.relationships.length;
      c.relationships = c.relationships.filter(r => r.targetContactId !== deletedId);
      if (c.relationships.length !== before) c.updatedAt = Date.now();
    });
    saveAllToStorage(); renderDirectory(); els.contactModal.hidden = true;
  });
  
  if (els.welcomeImportLaterBtn) els.welcomeImportLaterBtn.addEventListener('click', () => { els.welcomeImportModal.hidden = true; });
  if (els.welcomeImportNowBtn) els.welcomeImportNowBtn.addEventListener('click', () => {
    els.welcomeImportModal.hidden = true;
    if (els.vcfInput) els.vcfInput.click();
  });

  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.close).hidden = true));
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('mousedown', e => { if (e.target === b) b.hidden = true; }));
}

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  initLockScreen();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed:', err));
  }
});
