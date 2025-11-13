import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { search } from './rag.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

app.post('/api/ask', async (req, res) => {
  const { question, contextHint } = req.body as { question: string; contextHint?: string };
  if (!question) return res.status(400).json({ error: 'Missing question' });

  // 1) RAG: vyhľadaj relevantné kúsky
  const hits = await search(openai, `${contextHint ? contextHint + '\n' : ''}${question}`, 6);
  const citations = hits.map((h, i) => `[[${i+1}]] ${h.meta?.file || 'doc'}: ${h.text.slice(0, 180)}...`).join('\n');
  const system = `Si odborny poradca Carneo pre chytre hodinky a prstene. Odpovedaj strucne, vecne, s odkazmi na zdroje v tvare [1],[2].
Ak si nie si isty, navrhni eskalaciu na agenta.`;

  // 2) OpenAI Responses API (jednoduchá single-turn QA)
  const prompt = `Otazka:
${question}

Kontekst (relevantne pasaze):
${citations}

Pokyny: pouzi pasaze vyssie. Ak chyba info o produktoch, vysvetli co potrebujes doplnit.`;

  const response = await openai.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ]
  });

  const answer = (response as any).output_text || (response as any).content?.[0]?.text || '—';

  res.json({ answer, sources: hits.map((h) => ({ file: h.meta?.file, id: h.id })) });
});

// Zdravie
app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`Carneo AI bot bezi na http://localhost:${port}`));
