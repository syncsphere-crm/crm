/**
 * app.js - Local-first CRM with VCF Parsing, Network Map, and Local AI
 */

const STORAGE_KEY = 'rolodex_contacts_v1';

const state = {
  contacts: [],
  activeView: 'directory',
  tagFilter: '',
  relationFilter: '',
  overdueOnly: false,
  searchQuery: '',
  handleRowsDraft: [],
  relationRowsDraft: [],
  interactionsDraft: [],
  networkSim: null
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
    'globalSearch','aiSearchBtn','settingsBtn','contactGrid','emptyState','tagFilter',
    'overdueFilterBtn','relationFilter','resultCount','addContactBtn','reportOverdue',
    'reportTags','exportRawBtn','exportCsvBtn','dropZone','vcfInput','contactModal',
    'contactModalTitle','contactId','fullNameInput','tagsInput','frequencyInput',
    'handleRows','addHandleBtn','relationRows','relationTargetSelect','relationLabelInput',
    'addRelationBtn','notesInput','addInteractionBtn','interactionList','deleteContactBtn',
    'saveContactBtn','interactionModal','quickInteractionContactId','quickChannelInput',
    'quickSummaryInput','saveQuickInteractionBtn','settingsModal','wipeLocalBtn','networkCanvas'
  ];
  ids.forEach((id) => { els[id] = document.getElementById(id); });
}

// --- Storage ---
function loadAllFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.contacts = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.contacts = [];
  }
}
function saveAllToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.contacts));
}

// --- Formatting & Helpers ---
function isOverdue(contact) {
  if (!contact.frequencyGoalDays || !contact.lastContactedAt) return false;
  const days = (Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24);
  return days > contact.frequencyGoalDays;
}
function overdueLevel(contact) {
  if (!isOverdue(contact)) return 'ok';
  const days = (Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24);
  return days > contact.frequencyGoalDays * 2 ? 'red' : 'amber';
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}
function formatLastContacted(contact) {
  if (!contact.lastContactedAt) return 'Never';
  const days = Math.floor((Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Directory Rendering ---
function getFilteredContacts() {
  let list = state.contacts.filter((c) => !c.isDeleted);
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter((c) => {
      return (c.fullName?.toLowerCase().includes(q) || c.notes?.toLowerCase().includes(q) ||
             (c.tags || []).some(t => t.toLowerCase().includes(q)));
    });
  }
  if (state.tagFilter) list = list.filter((c) => (c.tags || []).includes(state.tagFilter));
  if (state.overdueOnly) list = list.filter(isOverdue);
  if (state.relationFilter) {
    list = list.filter((c) => (c.relationships || []).some((r) => r.targetContactId === state.relationFilter));
  }
  return list.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function renderDirectory() {
  const list = getFilteredContacts();
  els.resultCount.textContent = `${list.length} contacts`;
  els.contactGrid.innerHTML = '';
  els.emptyState.hidden = list.length > 0;

  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    const level = overdueLevel(c);
    const badgeClass = level === 'red' ? 'overdue-red' : level === 'amber' ? 'overdue-amber' : '';
    
    card.innerHTML = `
      <div class="card-top">
        <div class="card-pfp">${initials(c.fullName)}</div>
        <div><div class="card-name">${escapeHtml(c.fullName)}</div></div>
      </div>
      <div class="card-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-bottom">
        <span class="last-contact-badge ${badgeClass}">${formatLastContacted(c)}</span>
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

function populateTagFilterOptions() {
  const tags = new Set();
  state.contacts.filter((c) => !c.isDeleted).forEach((c) => (c.tags || []).forEach((t) => tags.add(t)));
  els.tagFilter.innerHTML = '<option value="">All tags</option>' + [...tags].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  
  els.relationFilter.innerHTML = '<option value="">All relationships</option>' + state.contacts.filter((c) => !c.isDeleted)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((c) => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
}

// --- Contact Modal (CRUD) ---
function openContactModal(id) {
  const isEdit = !!id;
  const contact = isEdit ? state.contacts.find((c) => c.id === id) : null;

  els.contactModalTitle.textContent = isEdit ? 'Edit contact' : 'New contact';
  els.contactId.value = id || '';
  els.fullNameInput.value = contact?.fullName || '';
  els.tagsInput.value = (contact?.tags || []).join(', ');
  els.frequencyInput.value = contact?.frequencyGoalDays ?? '';
  els.notesInput.value = contact?.notes || '';
  els.deleteContactBtn.hidden = !isEdit;

  state.handleRowsDraft = contact ? JSON.parse(JSON.stringify(contact.contactMethods || [])) : [];
  state.relationRowsDraft = contact ? JSON.parse(JSON.stringify(contact.relationships || [])) : [];
  state.interactionsDraft = contact ? JSON.parse(JSON.stringify(contact.interactions || [])) : [];

  renderHandleRows();
  renderRelationRows();
  renderInteractionList();
  populateRelationTargetSelect(id);
  els.contactModal.hidden = false;
}

function renderHandleRows() {
  els.handleRows.innerHTML = state.handleRowsDraft.map((h, idx) => `
    <div class="dynamic-row">
      <select class="select handle-select" data-idx="${idx}">
        ${['phone','email','whatsapp','other'].map((p) => `<option value="${p}" ${p === h.platform ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <input class="input handle-input" data-idx="${idx}" value="${escapeHtml(h.value)}" placeholder="Value">
      <button type="button" class="row-remove" data-remove-handle="${idx}">&times;</button>
    </div>
  `).join('');
  
  els.handleRows.querySelectorAll('.handle-select').forEach(el => el.addEventListener('change', e => state.handleRowsDraft[e.target.dataset.idx].platform = e.target.value));
  els.handleRows.querySelectorAll('.handle-input').forEach(el => el.addEventListener('input', e => state.handleRowsDraft[e.target.dataset.idx].value = e.target.value));
  els.handleRows.querySelectorAll('[data-remove-handle]').forEach(btn => btn.addEventListener('click', () => {
    state.handleRowsDraft.splice(+btn.dataset.removeHandle, 1);
    renderHandleRows();
  }));
}

function renderRelationRows() {
  els.relationRows.innerHTML = state.relationRowsDraft.map((r, idx) => {
    const target = state.contacts.find(c => c.id === r.targetContactId);
    return `<div class="dynamic-row">
      <span style="flex:1; font-size:13px;">${escapeHtml(r.label)} — <strong>${escapeHtml(target?.fullName || 'Unknown')}</strong></span>
      <button type="button" class="row-remove" data-remove-relation="${idx}">&times;</button>
    </div>`;
  }).join('');
  
  els.relationRows.querySelectorAll('[data-remove-relation]').forEach(btn => btn.addEventListener('click', () => {
    state.relationRowsDraft.splice(+btn.dataset.removeRelation, 1);
    renderRelationRows();
  }));
}

function populateRelationTargetSelect(excludeId) {
  els.relationTargetSelect.innerHTML = state.contacts
    .filter((c) => !c.isDeleted && c.id !== excludeId)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((c) => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
}

// --- EDIT & DELETE INTERACTIONS ---
function renderInteractionList() {
  const sorted = [...state.interactionsDraft].sort((a, b) => b.date - a.date);
  els.interactionList.innerHTML = sorted.map((i) => `
    <div class="interaction-item">
      <div class="interaction-meta"><span>${escapeHtml(i.channel)}</span><span>${new Date(i.date).toLocaleDateString()}</span></div>
      <div class="interaction-summary">${escapeHtml(i.summary)}</div>
      <div class="interaction-actions">
        <button type="button" class="btn btn-secondary btn-small" data-edit-interaction="${i.id}">Edit</button>
        <button type="button" class="btn btn-danger btn-small" data-delete-interaction="${i.id}">Delete</button>
      </div>
    </div>
  `).join('') || '<p class="empty-sub">No interactions logged yet.</p>';

  els.interactionList.querySelectorAll('[data-edit-interaction]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const iId = btn.dataset.editInteraction;
      const inter = state.interactionsDraft.find(x => x.id === iId);
      const newSummary = prompt("Edit Summary:", inter.summary);
      if (newSummary !== null) {
        inter.summary = newSummary;
        renderInteractionList();
      }
    });
  });

  els.interactionList.querySelectorAll('[data-delete-interaction]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if(confirm("Delete this interaction?")) {
        state.interactionsDraft = state.interactionsDraft.filter(x => x.id !== btn.dataset.deleteInteraction);
        renderInteractionList();
      }
    });
  });
}

function saveContactFromModal() {
  const id = els.contactId.value || uuid();
  const fullName = els.fullNameInput.value.trim();
  if (!fullName) { toast('Name required.'); return; }

  const lastContactedAt = state.interactionsDraft.length ? Math.max(...state.interactionsDraft.map((i) => i.date)) : undefined;

  const contact = {
    id, fullName,
    frequencyGoalDays: els.frequencyInput.value ? Number(els.frequencyInput.value) : undefined,
    lastContactedAt,
    contactMethods: state.handleRowsDraft.filter((h) => h.value.trim()),
    relationships: state.relationRowsDraft,
    tags: els.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
    notes: els.notesInput.value,
    interactions: state.interactionsDraft,
    updatedAt: Date.now(),
    isDeleted: false,
  };

  const idx = state.contacts.findIndex((c) => c.id === id);
  if (idx >= 0) state.contacts[idx] = contact; else state.contacts.push(contact);

  saveAllToStorage();
  populateTagFilterOptions();
  renderDirectory();
  els.contactModal.hidden = true;
  toast('Contact saved.');
  if (state.activeView === 'network') renderNetworkMap();
}

function deleteCurrentContact() {
  const id = els.contactId.value;
  if (!id || !confirm('Delete this contact?')) return;
  const contact = state.contacts.find((c) => c.id === id);
  if (contact) {
    contact.isDeleted = true;
    saveAllToStorage();
    populateTagFilterOptions();
    renderDirectory();
    els.contactModal.hidden = true;
    toast('Contact deleted.');
    if (state.activeView === 'network') renderNetworkMap();
  }
}

// --- Quick Interaction Modal ---
function openInteractionModal(contactId) {
  els.quickInteractionContactId.value = contactId;
  els.quickChannelInput.value = '';
  els.quickSummaryInput.value = '';
  els.interactionModal.hidden = false;
}
function saveQuickInteraction() {
  const id = els.quickInteractionContactId.value;
  const contact = state.contacts.find((c) => c.id === id);
  if (!contact) return;
  contact.interactions = contact.interactions || [];
  contact.interactions.push({ id: uuid(), date: Date.now(), channel: els.quickChannelInput.value.trim() || 'Touchpoint', summary: els.quickSummaryInput.value.trim() });
  contact.lastContactedAt = Date.now();
  saveAllToStorage();
  renderDirectory();
  els.interactionModal.hidden = true;
  toast('Interaction logged.');
}

// --- VCF IMPORT (Native Parsing) ---
function parseVCardAndSave(vcfData) {
  const cards = vcfData.split(/BEGIN:VCARD/i).filter(c => c.trim().length > 0);
  let imported = 0;

  for (let card of cards) {
    let fnMatch = card.match(/FN[^\:]*\:(.*)/i);
    if (!fnMatch) continue; 
    
    let fullName = fnMatch[1].trim();
    let handles = [];
    
    // Extract Phones
    const telRegex = /TEL[^\:]*\:(.*)/gi;
    let telMatch;
    while ((telMatch = telRegex.exec(card)) !== null) {
      handles.push({ platform: 'phone', value: telMatch[1].trim() });
    }
    
    // Extract Emails
    const emailRegex = /EMAIL[^\:]*\:(.*)/gi;
    let emailMatch;
    while ((emailMatch = emailRegex.exec(card)) !== null) {
      handles.push({ platform: 'email', value: emailMatch[1].trim() });
    }

    state.contacts.push({
      id: uuid(),
      fullName,
      contactMethods: handles,
      tags: ['Imported'],
      relationships: [],
      interactions: [],
      updatedAt: Date.now(),
      isDeleted: false
    });
    imported++;
  }

  if (imported > 0) {
    saveAllToStorage();
    populateTagFilterOptions();
    renderDirectory();
    toast(`Imported ${imported} contacts!`);
  } else {
    toast('No valid contacts found in VCF.');
  }
}

// --- NETWORK MAP (Force Directed Graph) ---
function renderNetworkMap() {
  const canvas = els.networkCanvas;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  const activeContacts = state.contacts.filter(c => !c.isDeleted);
  if (activeContacts.length === 0) {
    ctx.clearRect(0,0,width,height);
    ctx.fillText("No contacts to map.", width/2, height/2);
    return;
  }

  // Setup nodes
  const nodes = activeContacts.map(c => ({
    id: c.id, 
    label: c.fullName, 
    x: Math.random() * width, 
    y: Math.random() * height,
    vx: 0, vy: 0
  }));

  // Setup edges based on relationships
  const edges = [];
  activeContacts.forEach(c => {
    (c.relationships || []).forEach(r => {
      const targetNode = nodes.find(n => n.id === r.targetContactId);
      const sourceNode = nodes.find(n => n.id === c.id);
      if (targetNode && sourceNode) edges.push({ source: sourceNode, target: targetNode });
    });
  });

  // Simple Physics Simulation Loop
  if (state.networkSim) cancelAnimationFrame(state.networkSim);

  function simulate() {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx*dx + dy*dy) || 1;
        if (dist < 150) {
          let force = 100 / (dist * dist);
          nodes[i].vx -= (dx / dist) * force;
          nodes[i].vy -= (dy / dist) * force;
          nodes[j].vx += (dx / dist) * force;
          nodes[j].vy += (dy / dist) * force;
        }
      }
    }
    // Attraction
    edges.forEach(e => {
      let dx = e.target.x - e.source.x;
      let dy = e.target.y - e.source.y;
      let dist = Math.sqrt(dx*dx + dy*dy) || 1;
      let force = (dist - 80) * 0.01; 
      e.source.vx += (dx / dist) * force;
      e.source.vy += (dy / dist) * force;
      e.target.vx -= (dx / dist) * force;
      e.target.vy -= (dy / dist) * force;
    });

    // Update positions & draw
    ctx.clearRect(0, 0, width, height);
    
    // Draw edges
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    edges.forEach(e => {
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    });

    // Draw nodes
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    nodes.forEach(n => {
      // apply velocity & damping & center gravity
      n.vx += (width/2 - n.x) * 0.001;
      n.vy += (height/2 - n.y) * 0.001;
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.85; 
      n.vy *= 0.85;

      ctx.beginPath();
      ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6';
      ctx.fill();
      ctx.fillStyle = '#333';
      ctx.fillText(n.label, n.x, n.y - 12);
    });

    state.networkSim = requestAnimationFrame(simulate);
  }
  simulate();
}

// --- LOCAL AI SEARCH (window.ai) ---
async function runAISearch() {
  const query = els.globalSearch.value.trim();
  if (!query) { toast("Enter a question in the search bar first."); return; }

  if (!window.ai || !window.ai.languageModel) {
    alert("Local AI is not enabled in your browser.\n\nTo use this feature, you must use Chrome and enable the 'Prompt API for Gemini Nano' in chrome://flags.");
    return;
  }

  const activeContacts = state.contacts.filter(c => !c.isDeleted).map(c => ({
    name: c.fullName, tags: c.tags, notes: c.notes
  }));

  els.aiSearchBtn.textContent = "Thinking...";
  els.aiSearchBtn.disabled = true;

  try {
    const session = await window.ai.languageModel.create({
      systemPrompt: "You are a CRM assistant. Use the provided contact list JSON to answer the user's question accurately. Be brief."
    });
    
    const prompt = `Contact List Data: ${JSON.stringify(activeContacts)}\n\nQuestion: ${query}`;
    const result = await session.prompt(prompt);
    
    alert(`AI Result:\n\n${result}`);
  } catch (error) {
    console.error(error);
    alert("AI generation failed. Ensure your browser AI model is downloaded and active.");
  } finally {
    els.aiSearchBtn.textContent = "✨ Ask AI";
    els.aiSearchBtn.disabled = false;
  }
}

// --- App Init ---
function init() {
  cacheEls();
  loadAllFromStorage();

  // Navigation
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      const viewId = tab.dataset.view;
      document.getElementById(`view-${viewId}`).classList.add('active');
      state.activeView = viewId;
      
      if (viewId === 'network') renderNetworkMap();
      else if (state.networkSim) { cancelAnimationFrame(state.networkSim); state.networkSim = null; }
    });
  });

  // Search & Filters
  els.globalSearch.addEventListener('input', (e) => { state.searchQuery = e.target.value; renderDirectory(); });
  els.aiSearchBtn.addEventListener('click', runAISearch);
  els.tagFilter.addEventListener('change', (e) => { state.tagFilter = e.target.value; renderDirectory(); });
  els.relationFilter.addEventListener('change', (e) => { state.relationFilter = e.target.value; renderDirectory(); });
  els.overdueFilterBtn.addEventListener('click', () => { state.overdueOnly = !state.overdueOnly; els.overdueFilterBtn.dataset.active = state.overdueOnly; renderDirectory(); });

  // Modals
  els.addContactBtn.addEventListener('click', () => openContactModal(null));
  els.saveContactBtn.addEventListener('click', saveContactFromModal);
  els.deleteContactBtn.addEventListener('click', deleteCurrentContact);
  els.addHandleBtn.addEventListener('click', () => { state.handleRowsDraft.push({ platform: 'phone', value: '' }); renderHandleRows(); });
  els.addRelationBtn.addEventListener('click', () => {
    if (!els.relationTargetSelect.value || !els.relationLabelInput.value) return toast('Pick a person and label.');
    state.relationRowsDraft.push({ targetContactId: els.relationTargetSelect.value, label: els.relationLabelInput.value });
    els.relationLabelInput.value = '';
    renderRelationRows();
  });
  els.addInteractionBtn.addEventListener('click', () => {
    const channel = prompt('Channel (Coffee, Call, etc):'); if (channel === null) return;
    const summary = prompt('Summary:');
    state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: channel || 'Touchpoint', summary: summary || '' });
    renderInteractionList();
  });

  els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => els[btn.dataset.close].hidden = true));
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('click', e => { if (e.target === b) b.hidden = true; }));

  // File Import Dropzone
  els.vcfInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseVCardAndSave(ev.target.result);
    reader.readAsText(file);
  });
  els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.style.borderColor = '#3b82f6'; });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.style.borderColor = '#e2e8f0');
  els.dropZone.addEventListener('drop', e => {
    e.preventDefault(); els.dropZone.style.borderColor = '#e2e8f0';
    if (e.dataTransfer.files[0]) {
      const reader = new FileReader();
      reader.onload = (ev) => parseVCardAndSave(ev.target.result);
      reader.readAsText(e.dataTransfer.files[0]);
    }
  });

  populateTagFilterOptions();
  renderDirectory();
}

document.addEventListener('DOMContentLoaded', init);