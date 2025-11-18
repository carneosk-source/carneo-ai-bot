import fs from 'fs';
import path from 'path';

// Cache indexov v pamäti
let generalIndex: any[] | null = null;
let productIndex: any[] | null = null;
let techIndex: any[] | null = null;

function loadIndexOnce(fileName: string) {
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

// TECH index – technické e-maily / poznámky / manuály pre doménu "tech"
function getTechIndex() {
  if (!techIndex) {
    // očakávame JSON súbor s embeddingami, napr. výstup z indexovacieho skriptu
    techIndex = loadIndexOnce('rag-tech-index.json');
  }
  return techIndex;
}

function cosineSimilarity(a: number[], b: number[]) {
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
 * @param {{ domain?: 'general' | 'products' | 'tech' }} options
 * @returns {Promise<Array<{id: string, text: string, meta: any, score: number}>>}
 */
export async function search(openai: any, query: string, k = 6, options: { domain?: 'general' | 'products' | 'tech' } = {}) {
  const domain = options.domain || 'general';

  let index: any[];

  if (domain === 'products') {
    index = getProductIndex();
  } else if (domain === 'tech') {
    index = getTechIndex();
  } else {
    index = getGeneralIndex();
  }

  if (!index || index.length === 0) {
    console.warn(`⚠ RAG index for domain "${domain}" is empty.`);
    return [];
  }

  const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

  const embResp = await openai.embeddings.create({
    model: embeddingModel,
    input: query
  });

  const queryVector = embResp.data[0].embedding as number[];

  const scored = index
    .map((doc: any) => ({
      ...doc,
      score: cosineSimilarity(queryVector, doc.embedding)
    }))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, k);

  return scored;
}
