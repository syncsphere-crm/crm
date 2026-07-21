const STORAGE_KEY = 'syncsphere_contacts_v1';

window.state = {
  contacts: [],
  activeView: 'directory',
  searchQuery: '',
  handleRowsDraft: [],
  relationRowsDraft: [],
  interactionsDraft: [],
  pendingPfpBase64: null,
};

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
    'globalSearch','settingsBtn','contactGrid','emptyState',
    'resultCount','addContactBtn', 'authDriveBtn', 'syncDriveBtn',
    'contactModal', 'contactModalTitle','contactId','fullNameInput','tagsInput',
    'frequencyInput', 'frequencyUnit', 'handleRows','addHandleBtn',
    'relationRows','relationTargetSelect','relationLabelInput',
    'addRelationBtn','notesInput','addInteractionBtn','interactionList','deleteContactBtn',
    'saveContactBtn','interactionModal','quickInteractionContactId','quickChannelInput',
    'quickSummaryInput','saveQuickInteractionBtn','settingsModal','wipeLocalBtn',
    'pfpInput', 'pfpPreview', 'pfpImg', 'pfpInitial', 'removePfpBtn',
    'importVcfBtn', 'vcfInput', 'masterPassword'
  ];
  ids.forEach((id) => { els[id] = document.getElementById(id); });
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
  syncToDrive(); // Auto-sync triggered on save
}

// Drive Sync Logic
async function syncToDrive() {
  if (!GoogleDrive.isSignedIn()) return;
  const pw = els.masterPassword.value;
  if (!pw) return toast("Set a master password in settings to sync.");
  
  try {
    if (!CryptoEngine.isUnlocked()) {
      if (CryptoEngine.hasExistingVault()) {
        const ok = await CryptoEngine.unlockVault(pw);
        if(!ok) return toast("Invalid Master Password.");
      } else {
        await CryptoEngine.initializeVault(pw);
      }
    }
    els.syncDriveBtn.textContent = "Syncing...";
    const encrypted = await CryptoEngine.encrypt(window.state.contacts);
    await GoogleDrive.uploadBackup(encrypted);
    toast("Synced to Drive.");
  } catch(e) {
    console.error(e);
    toast("Sync failed.");
  } finally {
    els.syncDriveBtn.textContent = "Sync Data";
  }
}

async function pullFromDrive() {
  if (!GoogleDrive.isSignedIn()) return;
  const pw = els.masterPassword.value;
  if (!pw) return toast("Set a master password in settings to decrypt.");
  
  try {
     if (!CryptoEngine.isUnlocked()) {
      if (CryptoEngine.hasExistingVault()) {
        const ok = await CryptoEngine.unlockVault(pw);
        if(!ok) return toast("Invalid Master Password.");
      } else {
        await CryptoEngine.initializeVault(pw);
      }
    }
    const backup = await GoogleDrive.downloadBackup();
    if (backup) {
      const data = await CryptoEngine.decrypt(backup);
      window.state.contacts = data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderDirectory();
      toast("Restored from Drive.");
    }
  } catch(e) {
    console.error(e);
    toast("Restore failed.");
  }
}


// --- Helpers ---
function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Rendering ---
function renderDirectory() {
  let list = window.state.contacts.filter(c => !c.isDeleted);
  const q = window.state.searchQuery.toLowerCase();
  
  if (q) list = list.filter(c => c.fullName?.toLowerCase().includes(q) || c.notes?.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q)));
  
  list.sort((a, b) => a.fullName.localeCompare(b.fullName));
  
  els.resultCount.textContent = `${list.length} contacts`;
  els.contactGrid.innerHTML = '';
  els.emptyState.hidden = list.length > 0;

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
    els.contactGrid.appendChild(card);
  }
}

// --- PFP Logic ---
function updatePfpUI() {
  if (window.state.pendingPfpBase64) {
    els.pfpImg.src = window.state.pendingPfpBase64;
    els.pfpImg.hidden = false;
    els.pfpInitial.hidden = true;
    els.removePfpBtn.hidden = false;
  } else {
    els.pfpImg.hidden = true;
    els.pfpInitial.hidden = false;
    els.pfpInitial.textContent = initials(els.fullNameInput.value || '?');
    els.removePfpBtn.hidden = true;
  }
}

// --- Modals ---
function openContactModal(id) {
  const contact = id ? window.state.contacts.find((c) => c.id === id) : null;
  els.contactModalTitle.textContent = contact ? 'Edit contact' : 'New contact';
  els.contactId.value = id || '';
  els.fullNameInput.value = contact?.fullName || '';
  els.tagsInput.value = (contact?.tags || []).join(', ');
  
  // Handle frequency parsing back from days to UI
  if (contact?.frequencyGoalDays) {
     if (contact.frequencyGoalDays % 30 === 0) {
        els.frequencyInput.value = contact.frequencyGoalDays / 30;
        els.frequencyUnit.value = "30";
     } else if (contact.frequencyGoalDays % 7 === 0) {
        els.frequencyInput.value = contact.frequencyGoalDays / 7;
        els.frequencyUnit.value = "7";
     } else {
        els.frequencyInput.value = contact.frequencyGoalDays;
        els.frequencyUnit.value = "1";
     }
  } else {
     els.frequencyInput.value = '';
     els.frequencyUnit.value = "1";
  }

  els.notesInput.value = contact?.notes || '';
  els.deleteContactBtn.hidden = !contact;

  window.state.pendingPfpBase64 = contact?.pfpBase64 || null;
  updatePfpUI();

  window.state.handleRowsDraft = contact ? JSON.parse(JSON.stringify(contact.contactMethods || [])) : [];
  window.state.relationRowsDraft = contact ? JSON.parse(JSON.stringify(contact.relationships || [])) : [];
  window.state.interactionsDraft = contact ? JSON.parse(JSON.stringify(contact.interactions || [])) : [];

  renderHandleRows(); renderRelationRows(); renderInteractionList();
  els.relationTargetSelect.innerHTML = window.state.contacts.filter(c => !c.isDeleted && c.id !== id).map(c => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
  els.contactModal.hidden = false;
}

function saveContactFromModal() {
  const id = els.contactId.value || uuid();
  const fullName = els.fullNameInput.value.trim();
  if (!fullName) return toast('Name required.');

  // Calculate days
  const freqVal = els.frequencyInput.value ? Number(els.frequencyInput.value) : 0;
  const freqMulti = Number(els.frequencyUnit.value);
  const totalDays = freqVal > 0 ? freqVal * freqMulti : undefined;

  const contact = {
    id, fullName,
    pfpBase64: window.state.pendingPfpBase64,
    frequencyGoalDays: totalDays,
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
  indexSemanticSearch(); // Update search indices
  if (window.state.activeView === 'network' && window.renderNetworkMap) window.renderNetworkMap(window.state.contacts);
}

function renderHandleRows() {
  els.handleRows.innerHTML = window.state.handleRowsDraft.map((h, idx) => `<div class="dynamic-row"><input class="input handle-input" data-idx="${idx}" value="${escapeHtml(h.value)}" placeholder="Value"><button type="button" class="row-remove" data-remove-handle="${idx}">&times;</button></div>`).join('');
  els.handleRows.querySelectorAll('.handle-input').forEach(el => el.addEventListener('input', e => window.state.handleRowsDraft[e.target.dataset.idx].value = e.target.value));
  els.handleRows.querySelectorAll('[data-remove-handle]').forEach(btn => btn.addEventListener('click', () => { window.state.handleRowsDraft.splice(+btn.dataset.removeHandle, 1); renderHandleRows(); }));
}
function renderRelationRows() {
  els.relationRows.innerHTML = window.state.relationRowsDraft.map((r, idx) => `<div class="dynamic-row"><span style="flex:1;">${escapeHtml(r.label)}</span><button type="button" class="row-remove" data-remove-relation="${idx}">&times;</button></div>`).join('');
  els.relationRows.querySelectorAll('[data-remove-relation]').forEach(btn => btn.addEventListener('click', () => { window.state.relationRowsDraft.splice(+btn.dataset.removeRelation, 1); renderRelationRows(); }));
}
function renderInteractionList() {
  els.interactionList.innerHTML = [...window.state.interactionsDraft].sort((a,b) => b.date - a.date).map(i => `
    <div class="interaction-item">
      <div class="interaction-meta"><span>${escapeHtml(i.channel)}</span></div>
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

// Semantic Search Setup
const semanticWorker = new Worker('semantic-worker.js');
semanticWorker.onmessage = (e) => {
  if (e.data.type === 'query-result') {
      const topIds = e.data.results.map(r => r.id);
      window.state.contacts.forEach(c => {
         // Sort directory by semantic scores if available
         c._searchScore = topIds.indexOf(c.id);
      });
      renderDirectory();
  }
};
function indexSemanticSearch() {
  const payload = window.state.contacts.map(c => ({ id: c.id, text: `${c.fullName} ${c.notes} ${(c.tags||[]).join(' ')}` }));
  semanticWorker.postMessage({ type: 'index', payload });
}

// --- Init & Events ---
document.addEventListener('DOMContentLoaded', () => {
  cacheEls(); loadAllFromStorage(); renderDirectory(); indexSemanticSearch();

  els.globalSearch.addEventListener('input', (e) => {
    window.state.searchQuery = e.target.value;
    if (window.state.searchQuery.length > 3) {
       semanticWorker.postMessage({ type: 'query', payload: { text: window.state.searchQuery, topK: 10 } });
    }
    renderDirectory();
  });

  els.settingsBtn.addEventListener('click', () => { els.settingsModal.hidden = false; });
  els.wipeLocalBtn.addEventListener('click', () => {
    if(!confirm("Erase EVERYTHING?")) return;
    localStorage.removeItem(STORAGE_KEY); window.state.contacts = [];
    renderDirectory(); els.settingsModal.hidden = true; toast("Erased.");
  });

  // VCF Import
  els.importVcfBtn.addEventListener('click', () => els.vcfInput.click());
  els.vcfInput.addEventListener('change', (e) => {
     const file = e.target.files[0];
     if(!file) return;
     const reader = new FileReader();
     reader.onload = (ev) => {
         const parsed = VCardParser.parse(ev.target.result);
         parsed.forEach(p => { p.id = uuid(); window.state.contacts.push(p); });
         saveAllToStorage(); renderDirectory(); toast(`Imported ${parsed.length} contacts.`);
     };
     reader.readAsText(file);
  });

  // PFP File Reader
  els.pfpInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { window.state.pendingPfpBase64 = ev.target.result; updatePfpUI(); };
    reader.readAsDataURL(file);
  });
  els.removePfpBtn.addEventListener('click', () => { window.state.pendingPfpBase64 = null; updatePfpUI(); els.pfpInput.value = ''; });
  els.fullNameInput.addEventListener('input', updatePfpUI);

  // Tabs
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

  // Basic events
  els.addContactBtn.addEventListener('click', () => openContactModal(null));
  els.saveContactBtn.addEventListener('click', saveContactFromModal);
  els.addHandleBtn.addEventListener('click', () => { window.state.handleRowsDraft.push({ value: '' }); renderHandleRows(); });
  els.addRelationBtn.addEventListener('click', () => { window.state.relationRowsDraft.push({ targetContactId: els.relationTargetSelect.value, label: els.relationLabelInput.value }); renderRelationRows(); });
  els.addInteractionBtn.addEventListener('click', () => { window.state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: 'Note', summary: '' }); renderInteractionList(); });
  els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);
  els.deleteContactBtn.addEventListener('click', () => { if(confirm('Delete?')) { window.state.contacts.find(c => c.id === els.contactId.value).isDeleted = true; saveAllToStorage(); renderDirectory(); els.contactModal.hidden = true; }});
  
  els.authDriveBtn.addEventListener('click', async () => {
     try {
       await GoogleDrive.signIn();
       els.authDriveBtn.hidden = true;
       els.syncDriveBtn.hidden = false;
       toast("Connected to Google Drive");
       pullFromDrive();
     } catch (e) {
       toast("Drive auth failed");
     }
  });

  els.syncDriveBtn.addEventListener('click', syncToDrive);

  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.close).hidden = true));
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('mousedown', e => { if (e.target === b) b.hidden = true; }));
});