import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import textract from 'textract';
import { OpenAI } from 'openai';
import { chunkText } from './utils.js';
import { embedText, ensureIndex, saveIndex, VectorItem } from './rag.js';

async function extractText(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  if (ext === '.pdf') { const data = await pdf(buf); return data.text; }
  // DOCX, TXT, atď. cez textract
  return await new Promise<string>((resolve, reject) => {
    textract.fromBufferWithName(path.basename(filePath), buf, (err: any, text: string) => {
      if (err) reject(err); else resolve(text || '');
    });
  });
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Použitie: pnpm ingest ./docs/navod1.pdf ./docs/faq.docx'); process.exit(1); }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const index = await ensureIndex();

  for (const fp of files) {
    const text = (await extractText(fp)).replace(/\s+/g, ' ').trim();
    const chunks = chunkText(text);
    const vecs = await embedText(openai, chunks);
    chunks.forEach((ch, i) => index.push({ id: `${path.basename(fp)}::${i}`, text: ch, meta: { file: fp }, embedding: vecs[i] } as VectorItem));
    console.log(`Ingested ${fp} -> ${chunks.length} chunks`);
  }
  await saveIndex(index);
  console.log('Index uložený do data/index.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
