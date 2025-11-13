import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { search } from './rag.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static('public'));

// Root – jednoduchý text, použiteľný aj ako wake endpoint
app.get('/', (_req, res) => {
  res.send('Carneo AI Bot API is running.');
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

app.post('/api/ask', async (req, res) => {
  try {
    const { question, mode } = req.body as {
      question?: string;
      mode?: 'product' | 'order' | 'tech' | null;
      contextHint?: string;
    };

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }

    const baseSystem = `Si odborny poradca Carneo pre chytre hodinky, naramky a prstene.
Odpovedaj strucne, vecne, v slovencine alebo cestine podla jazyka dotazu, s odkazmi na zdroje v tvare [1],[2].
Ak si nie si isty, otvorene to povedz a navrhni eskalaciu na cloveka (Carneo podpora).`;

    let systemExtra = '';
    let searchHint = '';

    switch (mode) {
      case 'product':
        systemExtra = `
Prioritne ries vyber produktov znacky Carneo (hodinky, naramky, prstene, prislusenstvo).
NEodporucaj ine znacky (Garmin, Apple, Suunto, Samsung atd.), iba Carneo.
Ak odporucas konkretny produkt, vzdy uved presny nazov produktu tak, ako je v e-shope Carneo.
Ak mas v kontexte URL produktu (napr. z e-shopu www.carneo.sk), pouzi ju v odpovedi (napr. "Viac info: https://www.carneo.sk/...").
Ak URL nemas, nevymyslaj link – povedz, ze link doplni agent alebo ze zakaznik najde produkt podla nazvu vo vyhladavani na www.carneo.sk.`;
        searchHint = 'Tema: vyber produktu znacky Carneo, produkty z e-shopu www.carneo.sk.';
        break;

      case 'order':
        systemExtra = `
Zameraj sa na otazky o objednavkach, doprave, platbe, dodacej lehote, reklamacii a vrateni tovaru.
Ak chyba informacia o konkretnom cisle objednavky alebo osobnych udajoch, vysvetli, co presne by mal zakaznik poslat podpore (napr. cislo objednavky, e-mail).`;
        searchHint = 'Tema: objednavky, dorucenie, reklamacie, vratky.';
        break;

      case 'tech':
        systemExtra = `
Zameraj sa na technicke dotazy k produktom Carneo – parovanie hodiniek, aplikacia, kompatibilita s telefonom, baterka, aktualizacie a podobne.
Ak problem vyzera vazne alebo neda sa jednoducho vyriesit, navrhni kontakt na technicku podporu (Carneo servis).`;
        searchHint = 'Tema: technicke dotazy a navody k produktom Carneo.';
        break;

      default:
        searchHint = '';
    }

    const system = systemExtra ? `${baseSystem}\n${systemExtra}` : baseSystem;

    // RAG vyhľadávanie – doplníme hint podľa režimu
    const queryForSearch = `${searchHint ? searchHint + '\n' : ''}${question}`;
    const hits = await search(openai, queryForSearch, 6);

    const citations = hits
      .map((h, i) => {
        const urlPart = h.meta?.url ? ` URL: ${h.meta.url}` : '';
        return `[[${i + 1}]] ${h.meta?.file || 'doc'}: ${h.text.slice(0, 180)}...${urlPart}`;
      })
      .join('\n');

    const prompt = `Otazka zakaznika:
${question}

Kontekst (relevantne pasaze zo znalostnej baze Carneo):
${citations}

Pokyny:
- Pouzi informacie z pasazi vyssie.
- Odpovedaj vecne, v kratkych odstavcoch.
- Pri rezime "vyber produktu" uprednostnuj produkty Carneo, ine znacky nespominaj.
- Ak chyba dolezita informacia (napr. rozpocet, typ pouzitia, cislo objednavky), slusne si ju vypytaj.`;

    const response = await openai.responses.create({
      model: MODEL,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    });

    const answer =
      (response as any).output_text ??
      (response as any).content?.[0]?.text ??
      '—';

    res.json({
      answer,
      sources: hits.map((h) => ({
        file: h.meta?.file,
        id: h.id,
        url: (h.meta as any)?.url
      }))
    });
  } catch (error) {
    console.error('Ask error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Zdravie
app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Carneo AI bot bezi na http://localhost:${port}`);
});
