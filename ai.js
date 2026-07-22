/**
 * ai.js — Local LLM inference (on-device, no server calls)
 *
 * WHY THIS ISN'T GEMMA 3 ANYMORE:
 * Both Gemma 3 ONNX exports (plain and -GQA) still fail to load in-browser —
 * confirmed even in Firefox, not just a Chrome/WebGPU quirk — because Gemma
 * 3's ONNX Runtime WebGPU backend has known open crash/overflow bugs
 * (JSEP aborts, fp16 overflow) independent of which repo/device is used.
 * Switched to Qwen2 0.5B Instruct instead: a small, widely-used model with
 * mature, well-tested transformers.js support on both WebGPU *and* plain
 * CPU/wasm — so it no longer hard-requires a GPU at all, which also fixes
 * Firefox (no stable WebGPU there by default).
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

env.allowLocalModels = false;

// SmolLM2-1.7B-Instruct instead of Qwen2.5-1.5B: the Qwen 1.5B export hit the
// same class of in-browser ONNX Runtime loading failure as Gemma 3 did
// (broken/incompatible WebGPU op support for that particular export) rather
// than anything about model size. SmolLM2 was purpose-built by Hugging Face
// for on-device/in-browser inference and is the model actually used in most
// public transformers.js WebGPU demos, so it's a much safer bet to load
// correctly than picking another general-purpose export at random.
const MODEL_WEBGPU = 'onnx-community/SmolLM2-1.7B-Instruct';
const MODEL_WASM = 'onnx-community/Qwen2.5-0.5B-Instruct'; // fallback for devices without WebGPU — 1.7B on plain CPU would be painfully slow

let generator = null;
let loadingPromise = null;
let capabilityCache = null;
let deviceCache = null; // 'webgpu' | 'wasm'

/** Local AI (the generation model) is skipped entirely on phones/tablets and
 * lower-memory devices — deliberately wide net, since even recent phones
 * (iPhone 13 and similar) have crashed the mobile tab trying to hold a
 * multi-hundred-MB model in memory. This only gates the generation model;
 * the separate, much smaller (~25MB) semantic-search embedding model in
 * semantic-worker.js is unaffected and keeps working everywhere. */
function isSmallDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|Android.*Mobile/i.test(ua)) return true; // phones
  if (/iPad/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua))) return true; // iPadOS reports as "Macintosh"
  if ('deviceMemory' in navigator && navigator.deviceMemory < 8) return true; // Chrome/Android-only signal; wide threshold on purpose
  return false;
}

/** wasm works everywhere, so this device is always usable — we just prefer
 * WebGPU (faster) when it's actually available. */
export async function detectCapability() {
  if (capabilityCache) return capabilityCache;
  if (isSmallDevice()) {
    capabilityCache = { supported: false, reason: 'Local AI answers are disabled on phones/tablets and lower-memory devices to avoid crashing the page. Semantic search still works normally.' };
    return capabilityCache;
  }
  try {
    if ('gpu' in navigator && (await navigator.gpu.requestAdapter())) {
      deviceCache = 'webgpu';
    } else {
      deviceCache = 'wasm';
    }
  } catch (e) {
    deviceCache = 'wasm';
  }
  capabilityCache = { supported: true };
  return capabilityCache;
}

export function isLoaded() {
  return !!generator;
}

export async function loadModel(onProgress) {
  if (generator) return generator;
  if (loadingPromise) return loadingPromise;

  const capability = await detectCapability();
  if (!capability.supported) throw new Error(capability.reason);

  loadingPromise = (async () => {
    const modelId = deviceCache === 'webgpu' ? MODEL_WEBGPU : MODEL_WASM;
    const progress_callback = (p) => {
      if (onProgress && p.status === 'progress' && p.file) {
        onProgress(Math.round(p.progress || 0), p.file);
      }
    };
    try {
      generator = await pipeline('text-generation', modelId, { dtype: 'q4', device: deviceCache || 'wasm', progress_callback });
    } catch (err) {
      if (modelId === MODEL_WASM) throw err; // already on the safe fallback — nothing left to fall back to
      console.warn(`${modelId} failed to load in this browser, falling back to ${MODEL_WASM}`, err);
      generator = await pipeline('text-generation', MODEL_WASM, { dtype: 'q4', device: 'wasm', progress_callback });
    }
    return generator;
  })();

  try {
    return await loadingPromise;
  } catch (err) {
    loadingPromise = null;
    generator = null;
    throw err;
  }
}

/**
 * Generates a short answer grounded only in the contact data handed in.
 * Kept deliberately short (contacts data + short reply) since this all runs
 * on-device with no server round trip to fall back on for a long context.
 */
export async function answerQuestion(question, contactsContext) {
  if (!generator) throw new Error('Model not loaded yet.');

  // NOTE: Gemma 3's chat template only defines user/model turns — it has no
  // "system" role, and passing one throws a template error at generation
  // time (e.g. "System role not supported"). That's why answers were failing
  // on every device regardless of GPU: the previous version above sent a
  // separate system message. Folding the instruction into the single user
  // turn avoids the template error entirely.
  const messages = [
    {
      role: 'user',
      content:
        "You are a helpful assistant for a personal CRM. Answer the question in 1-3 short sentences, using ONLY facts explicitly written in the contact data below. " +
        "Never guess, infer, or assume a relationship, fact, or connection that isn't literally stated. If the answer isn't in the data, say you don't know — do not speculate.\n\n" +
        `Contact data:\n${contactsContext}\n\nQuestion: ${question}`,
    },
  ];

  const output = await generator(messages, {
    max_new_tokens: 120,
    temperature: 0.2,
    do_sample: false,
  });

  const reply = output[0]?.generated_text;
  if (Array.isArray(reply)) {
    const last = reply[reply.length - 1];
    return (last?.content || '').trim();
  }
  return String(reply || '').trim();
}

window.GemmaAI = { detectCapability, isLoaded, loadModel, answerQuestion };
