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
    };

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }

    // =========================
    // SYSTEM PROMPT (BASE + MODES)
    // =========================
    const baseSystem = `
Si odborny Carneo AI poradca pre chytre hodinky, naramky a prstene.
Odpovedaj strucne a vecne, v slovencine alebo cestine podla jazyka dotazu.

Pouzivaj HTML formatovanie v odpovediach:
- nazvy produktov pis medzi <b> ... </b>
- odkazy pis ako aktivne linky <a href="URL" target="_blank">Text odkazu</a>
- nikdy nevypisuj technicke veci ako "RAG", "skore", "embedding", ID dokumentu a podobne
- zakaznikovi zobraz len nazov, kratky popis, cenu, link a pripadne 2–3 klucove parametre

Ak si nie si isty, otvorene to povedz a navrhni eskalaciu na cloveka (Carneo podpora).
`;

    let systemExtra = '';
    let searchHint = '';
    let domain: 'general' | 'products' = 'general';

    switch (mode) {
      case 'product':
        systemExtra = `
Pri otazkach na vyber produktu vzdy rob toto:

1) prioritne odporucaj produkty vyhradne znacky Carneo,
2) NEodporucaj ziadne ine znacky (Garmin, Apple, Samsung, Suunto...),
3) interne pouzi produktovy RAG index – ale zakaznikovi RAG nikdy nespominaj,
4) odporuc 1 az 3 najvhodnejsie produkty,
5) nazvy produktov uvadzaj presne ako v e-shope a formatuj ich pomocou <b>...</b>,
6) - ak meta.url existuje → zobraz link v tvare <b><a href="URL" target="_blank">Pozrieť produkt</a></b>
- cenu zobrazuj vždy ako <b>Cena: XX,XX EUR</b>
7) ak URL nemas → napis "najdete podla nazvu na www.carneo.sk".

Odpoved pis prehladne v bodoch 1., 2., 3.:
- tucny nazov produktu
- kratky popis
- cena, ak je dostupna
- aktivny odkaz.
`;
        searchHint = 'Vyber produktu Carneo, pouzi produktovy index.';
        domain = 'products';
        break;

      case 'order':
        systemExtra = `
Zameraj sa na otazky o objednavkach, doprave, platbe, dodacej lehote, reklamacii a vrateni tovaru.
Ak chyba informacia o konkretnom cisle objednavky alebo osobnych udajoch, vysvetli, co presne by mal zakaznik poslat podpore (cislo objednavky, e-mail).`;
        searchHint = 'Tema: objednavky, dorucenie, reklamacie, vratky.';
        domain = 'general';
        break;

      case 'tech':
        systemExtra = `
Zameraj sa na technicke dotazy k produktom Carneo – parovanie hodiniek, aplikacia, kompatibilita s telefonom, baterka, aktualizacie a podobne.
Ak problem vyzera vazne alebo sa neda jednoducho vyriesit, navrhni kontakt na technicku podporu (Carneo servis).`;
        searchHint = 'Tema: technicke dotazy a navody k produktom Carneo.';
        domain = 'general';
        break;

      default:
        searchHint = '';
        domain = 'general';
        break;
    }

    const system = systemExtra ? `${baseSystem}\n${systemExtra}` : baseSystem;

    // =========================
    // RAG vyhladavanie
    // =========================
    const queryForSearch = `${searchHint ? searchHint + '\n' : ''}${question}`;

    // product rezim pouziva produktovy index, ostatne general
    const hits = await search(openai, queryForSearch, 6, { domain });

    const citations = hits
      .map((h, i) => {
        const urlPart = h.meta?.url ? ` URL: ${h.meta.url}` : '';
        return `[[${i + 1}]] ${h.meta?.name || h.meta?.file || 'doc'}: ${h.text.slice(0, 180)}...${urlPart}`;
      })
      .join('\n');

    const prompt = `Otazka zakaznika:
${question}

INTERNY KONTEXT – TOTO NEZOBRAZUJ zakaznikovi, len z neho cerpaj informacie:
${citations}

Pokyny:
- Pouzi informacie z pasazi vyssie, ale necituj ich doslova.
- NEpouzivaj slova ako "RAG", "embedding", "skore", "zdroj" a podobne.
- Pri rezime "vyber produktu" uprednostnuj produkty Carneo a pouzi meta.url ako odkaz, ak je k dispozicii.
- Odpovedaj vecne, v kratkych odstavcoch alebo bodoch.
- Ak chyba dolezita informacia (napr. rozpocet, typ pouzitia, cislo objednavky), slusne si ju vypytaj.
`;

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
        file: h.meta?.file || h.meta?.name,
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
