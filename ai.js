/**
 * ai.js — Local Gemma 3 inference (on-device, no server calls)
 *
 * Uses Google's Gemma 3 1B instruction model, 4-bit quantized, run entirely
 * in the browser via WebGPU (onnx-community/gemma-3-1b-it-ONNX + transformers.js).
 *
 * IMPORTANT NOTE ON SCOPE — read before changing MODEL_ID:
 * A real "Gemma 3 4B" build (onnx-community/gemma-3-4b-it-ONNX) does exist,
 * but it's a vision+text multimodal export meant for server/native ONNX
 * Runtime, not the transformers.js in-browser pipeline — and even quantized
 * it's several GB, which is a rough download for a small local-first CRM.
 * The 1B build below is confirmed to run through transformers.js on WebGPU
 * at a much more reasonable footprint (~1GB, 4-bit). If your target devices
 * and hosting can absorb the bigger download, swapping MODEL_ID to the 4B
 * multimodal repo would require switching from the text-generation pipeline
 * to AutoModelForImageTextToText — a bigger rewrite than a constant change.
 *
 * Browsers cannot address a device's NPU directly — there's no public web
 * API for that today. WebGPU (GPU / unified memory) is the real browser-side
 * acceleration path, so that's what capability detection below checks for.
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

env.allowLocalModels = false;

const MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';

let generator = null;
let loadingPromise = null;
let capabilityCache = null;

/**
 * Two-step detection: (1) does the browser expose navigator.gpu at all,
 * (2) does requestAdapter() actually resolve to a usable adapter (it can
 * return null on blocklisted drivers, remote desktops, some VMs, etc).
 * A low navigator.deviceMemory reading is an extra, coarse signal that the
 * device likely can't hold the model + KV cache comfortably.
 */
export async function detectCapability() {
  if (capabilityCache) return capabilityCache;

  if (!('gpu' in navigator)) {
    capabilityCache = { supported: false, reason: "This browser doesn't support WebGPU, which on-device Gemma 3 needs." };
    return capabilityCache;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      capabilityCache = { supported: false, reason: "No usable GPU adapter was found on this device/browser." };
      return capabilityCache;
    }
    if (navigator.deviceMemory && navigator.deviceMemory < 4) {
      capabilityCache = { supported: false, reason: "This device doesn't have enough memory to run Gemma 3 locally." };
      return capabilityCache;
    }
    capabilityCache = { supported: true };
    return capabilityCache;
  } catch (e) {
    capabilityCache = { supported: false, reason: "Couldn't initialize WebGPU on this device." };
    return capabilityCache;
  }
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
    generator = await pipeline('text-generation', MODEL_ID, {
      dtype: 'q4',
      device: 'webgpu',
      progress_callback: (p) => {
        if (onProgress && p.status === 'progress' && p.file) {
          onProgress(Math.round(p.progress || 0), p.file);
        }
      },
    });
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
        "You are a helpful assistant for a personal CRM. Answer the question in 1-3 short sentences, using ONLY the contact data provided. If the answer isn't in the data, say you don't know.\n\n" +
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
