/**
 * ai.js - Local Browser AI
 * Uses SmolLM-135M-Instruct (~85MB), an incredibly smart, tiny instruction model.
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// Fix for model downloading correctly
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1; 
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/';

let generator = null;

async function loadModel() {
  const statusEl = document.getElementById('aiStatus');
  if (statusEl) statusEl.textContent = "Downloading AI Model (One-time, ~85MB)...";
  
  try {
    generator = await pipeline('text-generation', 'Xenova/SmolLM-135M-Instruct');
    if (statusEl) {
        statusEl.textContent = "AI Ready.";
        setTimeout(() => { statusEl.textContent = ""; }, 3000);
    }
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "Failed to load model.";
    document.getElementById('aiSearchBtn').disabled = false;
  }
}

document.getElementById('aiSearchBtn').addEventListener('click', async () => {
  const query = document.getElementById('globalSearch').value.trim();
  if (!query) { alert("Enter a question in the search bar first."); return; }

  const btn = document.getElementById('aiSearchBtn');
  btn.disabled = true;
  btn.textContent = "Thinking...";

  if (!generator) {
    await loadModel();
  }

  if (generator) {
    const activeContacts = (window.state.contacts || []).filter(c => !c.isDeleted);
    
    const dataString = activeContacts.map(c => {
      const rels = (c.relationships||[]).map(r => r.label).join(', ');
      return `Name: ${c.fullName} | Tags: ${(c.tags||[]).join(', ')} | Relations: ${rels||'none'} | Notes: ${c.notes||'none'}`;
    }).join('\n');
    
    const systemPrompt = "You are an AI assistant for a CRM. Answer the user's question accurately based ONLY on the provided contact data. If the answer is not in the data, say 'I don't know'.";
    
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Contact Data:\n${dataString}\n\nQuestion: ${query}` }
    ];

    try {
      const prompt = generator.tokenizer.apply_chat_template(messages, { 
        tokenize: false, 
        add_generation_prompt: true 
      });

      const result = await generator(prompt, {
        max_new_tokens: 80,
        temperature: 0.1,
        repetition_penalty: 1.15
      });
      
      const generatedText = result[0].generated_text;
      const answerStart = generatedText.lastIndexOf("<|im_start|>assistant\n");
      const cleanAnswer = answerStart !== -1 
        ? generatedText.substring(answerStart + 22).replace("<|im_end|>", "").trim()
        : generatedText;

      alert(`✨ AI Answer:\n\n${cleanAnswer}`);
    } catch (e) {
      console.error(e);
      alert("Error generating response. The context might be too long for the browser memory.");
    }
  }

  btn.disabled = false;
  btn.textContent = "✨ Ask AI";
});