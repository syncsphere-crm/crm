/**
 * app.js - Core UI, Storage, PFP logic, SyncSphere Integrations, and Semantic Worker
 */
const STORAGE_KEY = 'syncsphere_contacts_v1';

window.state = {
  contacts: [],
  activeView: 'directory',
  tagFilter: '',
  relationFilter: '',
  overdueOnly: false,
  searchQuery: '',
  aiSearchEnabled: false,
  handleRowsDraft: [],
  relationRowsDraft: [],
  interactionsDraft: [],
  pendingPfpBase64: null,
};

let semanticWorker = null;
let promptInterval = null;
const EXAMPLE_PROMPTS = [
  '✨ Try: "Who works at Google?"',
  '✨ Try: "Friends from college"',
  '✨ Try: "Software developer in NYC"',
  '✨ Try: "Notes about coffee or lunch"'
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
    'globalSearch','settingsBtn','contactGrid','emptyState','tagFilter',
    'overdueFilterBtn','relationFilter','resultCount','addContactBtn','reportOverdue',
    'reportTags','exportRawBtn','exportCsvBtn','dropZone','triggerVcfBtn','vcfInput','contactModal',
    'contactModalTitle','contactId','fullNameInput','tagsInput','frequencyInput', 'frequencyUnitInput',
    'companyInput', 'jobTitleInput', 'schoolInput', 'locationInput',
    'handleRows','addHandleBtn','relationRows','relationTargetSelect','relationLabelInput',
    'addRelationBtn','notesInput','addInteractionBtn','interactionList','deleteContactBtn',
    'saveContactBtn','interactionModal','quickInteractionContactId','quickChannelInput',
    'quickSummaryInput','saveQuickInteractionBtn','settingsModal','wipeLocalBtn',
    'pfpInput', 'pfpPreview', 'pfpImg', 'pfpInitial', 'removePfpBtn',
    'gdriveLoginBtn', 'gdriveSyncBtn', 'gdriveLoadBtn', 'masterPasswordInput',
    'aiToggleBtn', 'aiStatus', 'searchInputContainer',
    'mergeContactsBtn', 'mergeModal', 'mergePrimarySelect', 'mergeSecondarySelect', 'confirmMergeBtn'
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
  indexSemanticSearch();
}

const DRIVE_CONNECTED_KEY = 'rolodex_drive_connected_v1';

/**
 * Merge a remote contact list into the local one, per-contact last-write-wins
 * by updatedAt. This is what actually makes multi-device sync safe: previously
 * a Drive load just overwrote window.state.contacts wholesale, so loading on
 * a second device could silently erase edits made locally after the last sync.
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
  if (!els.gdriveLoginBtn) return;
  els.gdriveLoginBtn.textContent = GoogleDrive.isSignedIn()
    ? 'Drive: Connected (tap to disconnect)'
    : 'Login to Google Drive';
}

async function handleDriveSync() {
  if (!GoogleDrive.isSignedIn()) return toast('Please login to Google Drive first.');
  const pwd = els.masterPasswordInput.value.trim();

  try {
    let payload;
    if (pwd) {
      toast('Encrypting and saving to Drive...');
      if (!CryptoEngine.hasExistingVault()) {
        await CryptoEngine.initializeVault(pwd);
      } else {
        const unlocked = await CryptoEngine.unlockVault(pwd);
        if (!unlocked) return toast('Invalid master password.');
      }
      payload = await CryptoEngine.encrypt(window.state.contacts);
      payload.encrypted = true;
    } else {
      toast('Saving to Drive...');
      payload = { v: 1, encrypted: false, data: window.state.contacts };
    }
    await GoogleDrive.uploadBackup(payload);
    toast('Saved to Google Drive.');
  } catch (err) {
    console.error(err);
    toast('Save failed. Check console.');
  }
}

async function handleDriveLoad(opts = {}) {
  const silent = !!opts.silent;
  if (!GoogleDrive.isSignedIn()) { if (!silent) toast('Please login to Google Drive first.'); return; }

  try {
    if (!silent) toast('Loading from Google Drive...');
    const payload = await GoogleDrive.downloadBackup();
    if (!payload) { if (!silent) toast('No backup found on Drive yet — try "Save to Drive" first.'); return; }

    // Legacy backups (from before encryption became optional) don't have an
    // `encrypted` flag but always have `iv`/`data` from CryptoEngine.encrypt.
    const isEncrypted = payload.encrypted === true || (payload.iv && typeof payload.data === 'string');

    let remoteContacts;
    if (isEncrypted) {
      const pwd = els.masterPasswordInput.value.trim();
      if (!pwd) { if (!silent) toast('This backup is encrypted — enter the master password first.'); return; }
      if (!CryptoEngine.hasExistingVault()) {
        await CryptoEngine.initializeVault(pwd);
      } else {
        const unlocked = await CryptoEngine.unlockVault(pwd);
        if (!unlocked) { if (!silent) toast('Invalid master password.'); return; }
      }
      remoteContacts = await CryptoEngine.decrypt(payload);
    } else {
      remoteContacts = Array.isArray(payload) ? payload : payload.data;
    }

    if (Array.isArray(remoteContacts)) {
      window.state.contacts = mergeContactsLWW(window.state.contacts, remoteContacts);
      saveAllToStorage();
      renderDirectory();
      if (!silent) toast('Synced with Google Drive.');
    }
  } catch (err) {
    console.error(err);
    if (!silent) toast('Load failed. Password might be wrong.');
  }
}

/** Called once on startup: if we've connected before, try to restore the
 * session without any popup. Does nothing (and shows nothing) if that fails —
 * failing silently here is the point, since most visitors have never
 * connected Drive at all. */
async function attemptSilentDriveLogin() {
  if (localStorage.getItem(DRIVE_CONNECTED_KEY) !== 'true') return;
  for (let i = 0; i < 20 && typeof google === 'undefined'; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const ok = await GoogleDrive.trySilentSignIn().catch(() => false);
  if (ok) {
    updateDriveUI();
    await handleDriveLoad({ silent: true });
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

// --- Semantic Worker System ---
function initSemanticWorker() {
  if (semanticWorker) return;
  try {
    // Note: { type: 'module' } is required for dynamic CDN imports inside workers
    semanticWorker = new Worker('./semantic-worker.js', { type: 'module' });
    semanticWorker.onmessage = (e) => {
      const { type, results, message } = e.data;
      if (type === 'index-complete') {
        if (els.aiStatus && window.state.aiSearchEnabled) els.aiStatus.textContent = 'AI Model Ready';
      } else if (type === 'query-result') {
        // Hybrid scoring: literal keyword hits get a boost on top of the semantic
        // similarity score, and — crucially — the ranked order is preserved all
        // the way to rendering (previously it was silently discarded and every
        // result set got re-sorted alphabetically, which is why AI mode never
        // looked any different from plain keyword search).
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
    const parts = [
      `Name: ${c.fullName}.`,
      c.jobTitle || c.company ? `Works as ${[c.jobTitle, c.company].filter(Boolean).join(' at ')}.` : '',
      c.school ? `Studied at ${c.school}.` : '',
      c.location ? `Located in ${c.location}.` : '',
      (c.tags || []).length ? `Tags: ${c.tags.join(', ')}.` : '',
      relText ? `Relationships: ${relText}.` : '',
      handleText ? `Reachable via: ${handleText}.` : '',
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
    semanticWorker.postMessage({ type: 'query', payload: { text: query, topK: 30 }, requestId: Date.now() });
  } else {
    renderDirectory();
  }
}

// --- Rendering ---
function populateFilterDropdowns() {
  const activeContacts = window.state.contacts.filter(c => !c.isDeleted);

  if (els.tagFilter) {
    const tags = Array.from(new Set(activeContacts.flatMap(c => c.tags || []))).sort((a, b) => a.localeCompare(b));
    const prevTag = window.state.tagFilter;
    els.tagFilter.innerHTML = '<option value="">All tags</option>' + tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    if (tags.includes(prevTag)) els.tagFilter.value = prevTag; else window.state.tagFilter = '';
  }

  if (els.relationFilter) {
    const prevRel = window.state.relationFilter;
    els.relationFilter.innerHTML = '<option value="">All relationships</option>' + activeContacts
      .map(c => `<option value="${c.id}">Related to ${escapeHtml(c.fullName)}</option>`).join('');
    if (activeContacts.some(c => c.id === prevRel)) els.relationFilter.value = prevRel; else window.state.relationFilter = '';
  }
}

function renderDirectoryWithFilter(customFilter = null, rankedIds = null) {
  populateFilterDropdowns();
  let list = window.state.contacts.filter(c => !c.isDeleted);
  
  if (customFilter) {
    list = list.filter(customFilter);
  } else {
    const q = window.state.searchQuery.toLowerCase();
    if (q) list = list.filter(c => c.fullName?.toLowerCase().includes(q) || c.notes?.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q)));
    if (window.state.tagFilter) list = list.filter(c => (c.tags || []).includes(window.state.tagFilter));
    if (window.state.overdueOnly) list = list.filter(isOverdue);
    if (window.state.relationFilter) list = list.filter(c => (c.relationships || []).some(r => r.targetContactId === window.state.relationFilter));
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
  const header = ['Full Name', 'Company', 'Job Title', 'School', 'Location', 'Tags', 'Notes', 'Contact Methods', 'Last Contacted'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = active.map(c => [
    c.fullName || '',
    c.company || '',
    c.jobTitle || '',
    c.school || '',
    c.location || '',
    (c.tags || []).join('; '),
    c.notes || '',
    (c.contactMethods || []).map(h => h.value).join('; '),
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
function openMergeModal() {
  const activeContacts = window.state.contacts.filter(c => !c.isDeleted);
  if (activeContacts.length < 2) return toast("Need at least 2 contacts to merge.");

  const options = activeContacts.map(c => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
  els.mergePrimarySelect.innerHTML = options;
  els.mergeSecondarySelect.innerHTML = options;
  if (activeContacts.length > 1) els.mergeSecondarySelect.selectedIndex = 1;

  els.mergeModal.hidden = false;
}

function executeMerge() {
  const pId = els.mergePrimarySelect.value;
  const sId = els.mergeSecondarySelect.value;
  if (pId === sId) return toast("Primary and secondary contact must be different.");

  const primary = window.state.contacts.find(c => c.id === pId);
  const secondary = window.state.contacts.find(c => c.id === sId);
  if (!primary || !secondary) return;

  primary.tags = Array.from(new Set([...(primary.tags || []), ...(secondary.tags || [])]));
  primary.contactMethods = [...(primary.contactMethods || []), ...(secondary.contactMethods || [])];
  primary.interactions = [...(primary.interactions || []), ...(secondary.interactions || [])];
  primary.relationships = [...(primary.relationships || []), ...(secondary.relationships || [])]
    .filter(r => r.targetContactId !== pId && r.targetContactId !== sId); // drop self-links
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

  // Repoint any other contact's relationships that pointed at the removed contact,
  // so those links don't silently vanish (they used to just dangle and disappear).
  window.state.contacts.forEach(c => {
    if (c.id === pId || c.id === sId || !c.relationships) return;
    c.relationships = c.relationships
      .map(r => r.targetContactId === sId ? { ...r, targetContactId: pId } : r)
      .filter(r => r.targetContactId !== c.id); // avoid accidental self-link after repoint
  });

  primary.updatedAt = Date.now();
  secondary.isDeleted = true;
  secondary.updatedAt = Date.now();

  saveAllToStorage();
  renderDirectory();
  els.mergeModal.hidden = true;
  toast(`Merged ${secondary.fullName} into ${primary.fullName}`);
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

  if (els.notesInput) els.notesInput.value = contact?.notes || '';
  if (els.deleteContactBtn) els.deleteContactBtn.hidden = !contact;

  window.state.pendingPfpBase64 = contact?.pfpBase64 || null;
  updatePfpUI();

  window.state.handleRowsDraft = contact ? JSON.parse(JSON.stringify(contact.contactMethods || [])) : [];
  window.state.relationRowsDraft = contact ? JSON.parse(JSON.stringify(contact.relationships || [])) : [];
  window.state.interactionsDraft = contact ? JSON.parse(JSON.stringify(contact.interactions || [])) : [];

  renderHandleRows(); renderRelationRows(); renderInteractionList();
  if (els.relationTargetSelect) els.relationTargetSelect.innerHTML = window.state.contacts.filter(c => !c.isDeleted && c.id !== id).map(c => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
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
    lastContactedAt: window.state.interactionsDraft.length ? Math.max(...window.state.interactionsDraft.map(i => i.date)) : undefined,
    contactMethods: window.state.handleRowsDraft.filter((h) => h.value.trim()),
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

// Ensures that if A links to B, B also shows a link back to A (relationships were
// previously one-directional: editing B never revealed the link A had made to it).
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

const HANDLE_PLATFORMS = ['phone', 'email', 'whatsapp', 'discord', 'instagram', 'snapchat', 'other'];

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

function renderRelationRows() {
  if(!els.relationRows) return;
  els.relationRows.innerHTML = window.state.relationRowsDraft.map((r, idx) => {
    const target = window.state.contacts.find(c => c.id === r.targetContactId);
    const targetName = target ? target.fullName : '(deleted contact)';
    return `<div class="dynamic-row" style="display:flex; gap:8px; margin-bottom:4px;"><span style="flex:1;">${escapeHtml(r.label)} — ${escapeHtml(targetName)}</span><button type="button" class="row-remove btn btn-ghost" data-remove-relation="${idx}">&times;</button></div>`;
  }).join('');
  els.relationRows.querySelectorAll('[data-remove-relation]').forEach(btn => btn.addEventListener('click', () => { window.state.relationRowsDraft.splice(+btn.dataset.removeRelation, 1); renderRelationRows(); }));
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

// --- Process Imported vCards ---
function processVCardFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { 
    try {
      const parsed = VCardParser.parse(ev.target.result);
      if (!parsed || parsed.length === 0) throw new Error("No contacts found in vCard file.");
      parsed.forEach(c => { c.id = uuid(); c.updatedAt = Date.now(); c.isDeleted = false; window.state.contacts.push(c); });
      saveAllToStorage(); renderDirectory();
      toast(`Imported ${parsed.length} contact(s)!`);
    } catch (err) { console.error(err); toast("Failed to parse vCard file."); }
  };
  reader.readAsText(file);
}

// --- Init & Events ---
document.addEventListener('DOMContentLoaded', () => {
  cacheEls(); loadAllFromStorage(); renderDirectory();

  if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => { els.settingsModal.hidden = false; });
  if (els.wipeLocalBtn) els.wipeLocalBtn.addEventListener('click', () => {
    if(!confirm("Erase EVERYTHING?")) return;
    localStorage.removeItem(STORAGE_KEY); window.state.contacts = [];
    renderDirectory(); els.settingsModal.hidden = true; toast("Erased.");
  });

  // Search & AI Toggle
  if (els.globalSearch) els.globalSearch.addEventListener('input', handleSearchInput);
  if (els.aiToggleBtn) els.aiToggleBtn.addEventListener('click', toggleAISearchMode);

  // Filter bar (previously had no listeners at all — dropdowns were unpopulated and inert)
  if (els.tagFilter) els.tagFilter.addEventListener('change', () => { window.state.tagFilter = els.tagFilter.value; renderDirectory(); });
  if (els.relationFilter) els.relationFilter.addEventListener('change', () => { window.state.relationFilter = els.relationFilter.value; renderDirectory(); });
  if (els.overdueFilterBtn) els.overdueFilterBtn.addEventListener('click', () => {
    window.state.overdueOnly = !window.state.overdueOnly;
    els.overdueFilterBtn.dataset.active = String(window.state.overdueOnly);
    renderDirectory();
  });

  // Export (previously unwired)
  if (els.exportRawBtn) els.exportRawBtn.addEventListener('click', exportRawJson);
  if (els.exportCsvBtn) els.exportCsvBtn.addEventListener('click', exportCsv);

  // Google Drive Handlers
  updateDriveUI();
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
      await handleDriveLoad();
    } catch (e) { toast('Drive login failed: ' + e.message); console.error(e); }
  });
  if (els.gdriveSyncBtn) els.gdriveSyncBtn.addEventListener('click', handleDriveSync);
  if (els.gdriveLoadBtn) els.gdriveLoadBtn.addEventListener('click', () => handleDriveLoad());
  attemptSilentDriveLogin();

  // Merge Feature Handlers
  if (els.mergeContactsBtn) els.mergeContactsBtn.addEventListener('click', openMergeModal);
  if (els.confirmMergeBtn) els.confirmMergeBtn.addEventListener('click', executeMerge);

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
  if (els.addRelationBtn) els.addRelationBtn.addEventListener('click', () => {
    const targetId = els.relationTargetSelect.value;
    const label = els.relationLabelInput.value.trim();
    if (!targetId) return toast('Add another contact first to link a relationship.');
    if (!label) return toast('Enter a relationship label (e.g. Sister).');
    if (window.state.relationRowsDraft.some(r => r.targetContactId === targetId && r.label.toLowerCase() === label.toLowerCase())) {
      return toast('That relationship already exists.');
    }
    window.state.relationRowsDraft.push({ targetContactId: targetId, label });
    els.relationLabelInput.value = '';
    renderRelationRows();
  });
  if (els.addInteractionBtn) els.addInteractionBtn.addEventListener('click', () => { window.state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: 'Note', summary: '' }); renderInteractionList(); });
  if (els.saveQuickInteractionBtn) els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);
  if (els.deleteContactBtn) els.deleteContactBtn.addEventListener('click', () => {
    if (!confirm('Delete?')) return;
    const deletedId = els.contactId.value;
    const deleted = window.state.contacts.find(c => c.id === deletedId);
    if (!deleted) return;
    deleted.isDeleted = true;
    deleted.updatedAt = Date.now();
    // Clean up other contacts' relationship links that pointed at this contact,
    // so they don't show a dangling "(deleted contact)" reference.
    window.state.contacts.forEach(c => {
      if (c.id === deletedId || !c.relationships) return;
      const before = c.relationships.length;
      c.relationships = c.relationships.filter(r => r.targetContactId !== deletedId);
      if (c.relationships.length !== before) c.updatedAt = Date.now();
    });
    saveAllToStorage(); renderDirectory(); els.contactModal.hidden = true;
  });
  
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.close).hidden = true));
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('mousedown', e => { if (e.target === b) b.hidden = true; }));
});