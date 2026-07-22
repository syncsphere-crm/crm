/**
 * semantic-worker.js
 * Browser worker for vector similarity search via Transformers.js
 */

let extractorPromise = null;
let corpus = [];

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1');
      env.allowLocalModels = false;
      return pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
    })();
  }
  return extractorPromise;
}

async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

self.onmessage = async (e) => {
  const { type, payload, requestId } = e.data;
  try {
    if (type === 'index') {
      // Items may already carry a cached `embedding` (unchanged since last
      // index, restored from the app's local/Drive cache) — only the
      // remaining items actually need a fresh embed() call. This is what
      // makes re-indexing after a small edit cheap instead of recomputing
      // every contact's embedding from scratch.
      const results = [];
      for (const item of payload) {
        if (!item.text || !item.text.trim()) continue;
        if (item.embedding) {
          results.push({ id: item.id, embedding: item.embedding, hash: item.hash });
          continue;
        }
        const embedding = await embed(`Represent this contact for retrieval: ${item.text}`);
        results.push({ id: item.id, embedding, hash: item.hash });
      }
      corpus = results;
      // Hand the full corpus back so the app can persist any newly-computed
      // embeddings into its cache (and sync that cache to Drive).
      self.postMessage({ type: 'index-complete', requestId, count: results.length, corpus: results });
    } else if (type === 'query') {
      if (!payload.text || !payload.text.trim()) {
        self.postMessage({ type: 'query-result', requestId, results: [] });
        return;
      }
      const queryEmbedding = await embed(`Represent this sentence for searching relevant contacts: ${payload.text}`);
      const scored = corpus
        .map((c) => ({ id: c.id, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, payload.topK || 20);
      self.postMessage({ type: 'query-result', requestId, results: scored });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: err.message || String(err) });
  }
};