import fs from 'fs';
import path from 'path';

// Cache indexov v pamäti
let generalIndex = null;
let productIndex = null;

function loadIndexOnce(fileName) {
  try {
    const filePath = path.join(process.cwd(), 'data', fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠ RAG index file not found: ${filePath}`);
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`⚠ RAG index file ${filePath} does not contain an array`);
      return [];
    }
    return parsed;
  } catch (e) {
    console.error('Error loading RAG index', fileName, e);
    return [];
  }
}

function getGeneralIndex() {
  if (!generalIndex) {
    // pôvodný index z ingestu (návody, manuály, atď.)
    generalIndex = loadIndexOnce('index.json');
  }
  return generalIndex;
}

function getProductIndex() {
  if (!productIndex) {
    // nový index s produktmi z Heureka feedu
    productIndex = loadIndexOnce('carneo-products-index.json');
  }
  return productIndex;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Vyhľadá najrelevantnejšie dokumenty.
 *
 * @param {OpenAI} openai - inštancia OpenAI klienta
 * @param {string} query - otázka
 * @param {number} k - počet výsledkov
 * @param {{ domain?: 'general' | 'products' }} options
 * @returns {Promise<Array<{id: string, text: string, meta: any, score: number}>>}
 */
export async function search(openai, query, k = 6, options = {}) {
  const domain = options.domain || 'general';

  const index =
    domain === 'products'
      ? getProductIndex()
      : getGeneralIndex();

  if (!index || index.length === 0) {
    console.warn(`⚠ RAG index for domain "${domain}" is empty.`);
    return [];
  }

  const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const TECH_FILE = path.join(process.cwd(), 'data', 'rag-tech.jsonl');

  const embResp = await openai.embeddings.create({
    model: embeddingModel,
    input: query
  });

  const queryVector = embResp.data[0].embedding;

  const scored = index
    .map((doc) => ({
      ...doc,
      score: cosineSimilarity(queryVector, doc.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored;
}
