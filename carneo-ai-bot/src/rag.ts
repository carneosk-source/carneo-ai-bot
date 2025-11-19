import fs from 'fs';
import path from 'path';

// Cache indexov v pamäti
let generalIndex: any[] | null = null;
let productIndex: any[] | null = null;
let techIndex: any[] | null = null;

function loadIndexOnce(fileName: string): any[] {
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

// JSONL loader (pre e-maily: rag-tech.jsonl)
function loadJsonlIndexOnce(fileName: string): any[] {
  try {
    const filePath = path.join(process.cwd(), 'data', fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠ RAG JSONL file not found: ${filePath}`);
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const out: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // očakávame: { id, text, embedding, meta }
        if (obj && obj.embedding && obj.text) {
          out.push(obj);
        }
      } catch (e) {
        console.warn('⚠ Cannot parse JSONL line in', fileName, e);
      }
    }
    return out;
  } catch (e) {
    console.error('Error loading RAG JSONL index', fileName, e);
    return [];
  }
}

function getGeneralIndex(): any[] {
  if (!generalIndex) {
    // pôvodný index z ingestu (návody, manuály, atď.)
    generalIndex = loadIndexOnce('index.json');
  }
  return generalIndex || [];
}

function getProductIndex(): any[] {
  if (!productIndex) {
    // nový index s produktmi z Heureka feedu
    productIndex = loadIndexOnce('carneo-products-index.json');
  }
  return productIndex || [];
}

function getTechIndex(): any[] {
  if (!techIndex) {
    // manuály (index.json) + tech e-maily (rag-tech.jsonl)
    const manuals = getGeneralIndex();
    const emails = loadJsonlIndexOnce('rag-tech.jsonl');

    techIndex = [...manuals, ...emails];
    console.log(
      `Tech index loaded: manuals=${manuals.length}, emails=${emails.length}, total=${techIndex.length}`
    );
  }
  return techIndex || [];
}

function cosineSimilarity(a: number[], b: number[]): number {
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
export async function search(openai: any, query: string, k = 6, options: any = {}) {
  const domain = options.domain || 'general';

  let index: any[] = [];
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

  const embeddingModel =
  process.env.EMBEDDING_MODEL || 'text-embedding-3-large';

  const embResp = await openai.embeddings.create({
    model: embeddingModel,
    input: query
  });

  const queryVector = embResp.data[0].embedding as number[];

  const scoredRaw = index
  .map((doc) => ({
    ...doc,
    score: cosineSimilarity(queryVector, doc.embedding)
  }))
  .sort((a, b) => b.score - a.score);

// DEBUG: log top 5
console.log("\n🔍 RAG DEBUG QUERY:", query);
for (let i = 0; i < Math.min(5, scoredRaw.length); i++) {
  console.log(
    ` #${i + 1} | score=${scoredRaw[i].score.toFixed(3)} | name=${scoredRaw[i].meta?.name}`
  );
}

// nový threshold
const MIN_SCORE = 0.18; // bezpečné nízke, nech prstene vždy nájde
const scored = scoredRaw.filter(d => d.score >= MIN_SCORE).slice(0, k);

return scored;
}
