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
    'handleRows','addHandleBtn','relationRows','relationTargetSelect','relationLabelInput',
    'addRelationBtn','notesInput','addInteractionBtn','interactionList','deleteContactBtn',
    'saveContactBtn','interactionModal','quickInteractionContactId','quickChannelInput',
    'quickSummaryInput','saveQuickInteractionBtn','settingsModal','wipeLocalBtn',
    'pfpInput', 'pfpPreview', 'pfpImg', 'pfpInitial', 'removePfpBtn',
    'gdriveLoginBtn', 'gdriveSyncBtn', 'masterPasswordInput', 'aiToggleBtn', 'aiStatus',
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

async function handleDriveSync() {
  const pwd = els.masterPasswordInput.value;
  if (!pwd) return toast('Master password required for encryption.');
  if (!GoogleDrive.isSignedIn()) return toast('Please login to Google Drive first.');

  try {
    toast('Encrypting and syncing...');
    if (!CryptoEngine.hasExistingVault()) {
      await CryptoEngine.initializeVault(pwd);
    } else {
      const unlocked = await CryptoEngine.unlockVault(pwd);
      if (!unlocked) return toast('Invalid master password.');
    }

    const payload = await CryptoEngine.encrypt(window.state.contacts);
    await GoogleDrive.uploadBackup(payload);
    toast('Successfully synced to Google Drive!');
  } catch (err) {
    console.error(err);
    toast('Sync failed. Check console.');
  }
}

async function handleDriveLoad() {
  const pwd = els.masterPasswordInput.value;
  if (!pwd) return toast('Master password required for decryption.');
  if (!GoogleDrive.isSignedIn()) return toast('Please login to Google Drive first.');

  try {
    toast('Downloading and decrypting...');
    const payload = await GoogleDrive.downloadBackup();
    if (!payload) return toast('No backup found on Drive.');

    if (!CryptoEngine.hasExistingVault()) {
       await CryptoEngine.initializeVault(pwd);
    } else {
       const unlocked = await CryptoEngine.unlockVault(pwd);
       if (!unlocked) return toast('Invalid master password.');
    }

    const decrypted = await CryptoEngine.decrypt(payload);
    if (decrypted && Array.isArray(decrypted)) {
      window.state.contacts = decrypted;
      saveAllToStorage();
      renderDirectory();
      toast('Data loaded from Google Drive!');
    }
  } catch (err) {
    console.error(err);
    toast('Load failed. Password might be wrong.');
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
        const matchingIds = new Set(results.filter(r => r.score > 0.25).map(r => r.id));
        renderDirectoryWithFilter((c) => matchingIds.has(c.id));
        if (els.aiStatus) els.aiStatus.textContent = `Found ${matchingIds.size} semantic matches`;
      } else if (type === 'error') {
        console.error("Worker error:", message);
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
  
  const docs = window.state.contacts.filter(c => !c.isDeleted).map(c => ({
    id: c.id,
    text: `Name: ${c.fullName}. Tags: ${(c.tags||[]).join(' ')}. Notes: ${c.notes || ''}`
  }));
  
  semanticWorker.postMessage({ type: 'index', payload: docs, requestId: Date.now() });
}

function toggleAISearchMode() {
  window.state.aiSearchEnabled = !window.state.aiSearchEnabled;
  if (els.aiToggleBtn) {
    els.aiToggleBtn.classList.toggle('active', window.state.aiSearchEnabled);
  }

  clearInterval(promptInterval);

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
    if (window.state.aiSearchEnabled && els.aiStatus) els.aiStatus.textContent = "AI Search Mode Active";
    return;
  }

  if (window.state.aiSearchEnabled) {
    if (!semanticWorker) initSemanticWorker();
    if (els.aiStatus) els.aiStatus.textContent = "Analyzing meanings...";
    semanticWorker.postMessage({ type: 'query', payload: { text: query, topK: 20 }, requestId: Date.now() });
  } else {
    renderDirectory();
  }
}

// --- Rendering ---
function renderDirectoryWithFilter(customFilter = null) {
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
  
  list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  
  if (els.resultCount) els.resultCount.textContent = `${list.length} contacts`;
  if (els.contactGrid) els.contactGrid.innerHTML = '';
  if (els.emptyState) els.emptyState.hidden = list.length > 0;

  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    
    const pfpHtml = c.pfpBase64 
        ? `<img src="${c.pfpBase64}" style="width:100%;height:100%;object-fit:cover;">` 
        : initials(c.fullName);

    card.innerHTML = `
      <div class="card-top">
        <div class="card-pfp" style="overflow:hidden;">${pfpHtml}</div>
        <div><div class="card-name">${escapeHtml(c.fullName)}</div></div>
      </div>
      <div class="card-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-bottom">
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
  primary.relationships = [...(primary.relationships || []), ...(secondary.relationships || [])];
  
  if (secondary.notes) {
    primary.notes = (primary.notes ? primary.notes + '\n\n' : '') + `[Merged Note from ${secondary.fullName}]:\n` + secondary.notes;
  }

  secondary.isDeleted = true;

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

  saveAllToStorage(); renderDirectory();
  els.contactModal.hidden = true;
  if (window.state.activeView === 'network' && window.renderNetworkMap) window.renderNetworkMap(window.state.contacts);
}

function renderHandleRows() {
  if(!els.handleRows) return;
  els.handleRows.innerHTML = window.state.handleRowsDraft.map((h, idx) => `<div class="dynamic-row" style="display:flex; gap:8px; margin-bottom:4px;"><input class="input handle-input" data-idx="${idx}" value="${escapeHtml(h.value)}" placeholder="Value"><button type="button" class="row-remove btn btn-ghost" data-remove-handle="${idx}">&times;</button></div>`).join('');
  els.handleRows.querySelectorAll('.handle-input').forEach(el => el.addEventListener('input', e => window.state.handleRowsDraft[e.target.dataset.idx].value = e.target.value));
  els.handleRows.querySelectorAll('[data-remove-handle]').forEach(btn => btn.addEventListener('click', () => { window.state.handleRowsDraft.splice(+btn.dataset.removeHandle, 1); renderHandleRows(); }));
}

function renderRelationRows() {
  if(!els.relationRows) return;
  els.relationRows.innerHTML = window.state.relationRowsDraft.map((r, idx) => `<div class="dynamic-row" style="display:flex; gap:8px; margin-bottom:4px;"><span style="flex:1;">${escapeHtml(r.label)}</span><button type="button" class="row-remove btn btn-ghost" data-remove-relation="${idx}">&times;</button></div>`).join('');
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
  contact.interactions = contact.interactions || [];
  contact.interactions.push({ id: uuid(), date: Date.now(), channel: els.quickChannelInput.value || 'Touchpoint', summary: els.quickSummaryInput.value });
  saveAllToStorage(); renderDirectory(); els.interactionModal.hidden = true;
}

// --- Process Imported vCards ---
function processVCardFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { 
    try {
      const parsed = VCardParser.parse(ev.target.result);
      if (!parsed || parsed.length === 0) throw new Error("No contacts found in vCard file.");
      parsed.forEach(c => { c.id = uuid(); window.state.contacts.push(c); });
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

  // Google Drive Handlers
  if (els.gdriveLoginBtn) els.gdriveLoginBtn.addEventListener('click', async () => {
    try {
      await GoogleDrive.signIn();
      toast('Logged into Google Drive!');
      els.gdriveLoginBtn.textContent = 'Drive: Authenticated';
      handleDriveLoad();
    } catch (e) { toast('Drive login failed: ' + e.message); console.error(e); }
  });
  if (els.gdriveSyncBtn) els.gdriveSyncBtn.addEventListener('click', handleDriveSync);

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
  if (els.addHandleBtn) els.addHandleBtn.addEventListener('click', () => { window.state.handleRowsDraft.push({ value: '' }); renderHandleRows(); });
  if (els.addRelationBtn) els.addRelationBtn.addEventListener('click', () => { window.state.relationRowsDraft.push({ targetContactId: els.relationTargetSelect.value, label: els.relationLabelInput.value }); renderRelationRows(); });
  if (els.addInteractionBtn) els.addInteractionBtn.addEventListener('click', () => { window.state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: 'Note', summary: '' }); renderInteractionList(); });
  if (els.saveQuickInteractionBtn) els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);
  if (els.deleteContactBtn) els.deleteContactBtn.addEventListener('click', () => { if(confirm('Delete?')) { window.state.contacts.find(c => c.id === els.contactId.value).isDeleted = true; saveAllToStorage(); renderDirectory(); els.contactModal.hidden = true; }});
  
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.close).hidden = true));
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('mousedown', e => { if (e.target === b) b.hidden = true; }));
});