/**
 * ai.js - 100% Local Browser AI using Transformers.js
 * Powered by a tiny FLAN-T5 model (~70MB down to ~25MB quantized)
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// We do not want it to look for local Node files, force it to fetch from CDN.
env.allowLocalModels = false;
// Use WebAssembly (which falls back to WebGPU/WebGL natively in modern browsers)
env.backends.onnx.wasm.numThreads = 1; 

let generator = null;

async function loadModel() {
  const statusEl = document.getElementById('aiStatus');
  statusEl.textContent = "Downloading AI Model (One-time, ~40MB)...";
  
  try {
    // Xenova/LaMini-Flan-T5-77M is a tiny model excellent for basic text processing.
    generator = await pipeline('text2text-generation', 'Xenova/LaMini-Flan-T5-77M');
    statusEl.textContent = "AI Ready.";
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load model.";
    document.getElementById('aiSearchBtn').disabled = false;
  }
}

document.getElementById('aiSearchBtn').addEventListener('click', async () => {
  const query = document.getElementById('globalSearch').value.trim();
  if (!query) { alert("Enter a question in the search bar first."); return; }

  const btn = document.getElementById('aiSearchBtn');
  btn.disabled = true;
  btn.textContent = "Thinking...";

  // Lazy load the model on first click
  if (!generator) {
    await loadModel();
  }

  if (generator) {
    // Prepare the CRM data context
    const activeContacts = (window.state.contacts || []).filter(c => !c.isDeleted);
    const dataString = activeContacts.map(c => `${c.fullName} (Tags: ${(c.tags||[]).join(', ')}). Notes: ${c.notes||'None'}`).join(' | ');
    
    const prompt = `Context: ${dataString}\n\nQuestion: ${query}\n\nAnswer:`;

    try {
      const result = await generator(prompt, {
        max_new_tokens: 50,
        temperature: 0.1,
      });
      alert(`AI Answer:\n\n${result[0].generated_text}`);
    } catch (e) {
      console.error(e);
      alert("Error generating response.");
    }
  }

  btn.disabled = false;
  btn.textContent = "✨ Ask AI";
});
