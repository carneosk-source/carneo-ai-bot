import fs from 'fs/promises';
import path from 'path';
import { OpenAI } from 'openai';
import { cosineSim } from './utils.js';

const DATA_PATH = path.resolve('data/index.json');

export type VectorItem = { id: string; text: string; meta?: Record<string, any>; embedding: number[] };

export async function ensureIndex(): Promise<VectorItem[]> {
  try { const raw = await fs.readFile(DATA_PATH, 'utf8'); return JSON.parse(raw); }
  catch { await fs.mkdir(path.dirname(DATA_PATH), { recursive: true }); await fs.writeFile(DATA_PATH, '[]', 'utf8'); return []; }
}

export async function saveIndex(items: VectorItem[]) {
  await fs.writeFile(DATA_PATH, JSON.stringify(items), 'utf8');
}

export async function embedText(openai: OpenAI, texts: string[]): Promise<number[][]> {
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const res = await openai.embeddings.create({ model, input: texts });
  return res.data.map((x: any) => x.embedding as number[]);
}

export async function search(openai: OpenAI, query: string, k = 6) {
  const items = await ensureIndex();
  if (!items.length) return [] as VectorItem[];
  const [qv] = await embedText(openai, [query]);
  const scored = items.map((it) => ({ it, score: cosineSim(qv, it.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.it);
  return scored;
}
