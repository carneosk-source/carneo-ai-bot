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
        // 1) Najprv skontroluj otázku
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }

    // ------------------------------------------
// AUTOMATICKÉ ROZPOZNANIE TYPU OTÁZKY
// ------------------------------------------

let effectiveMode: 'product' | 'order' | 'tech' | null = mode ?? null;

// Ak používateľ neklikol žiadnu možnosť vo widgete,
/// automaticky odhadneme podľa textu otázky.
if (!effectiveMode) {
  const q = question.toLowerCase();

  const isOrder =
    q.includes('objednavk') ||
    q.includes('objednávk') ||
    q.includes('cislo objednavky') ||
    q.includes('číslo objednávky') ||
    q.includes('dorucen') ||
    q.includes('doručen') ||
    q.includes('doprava') ||
    q.includes('dodanie') ||
    q.includes('faktura') ||
    q.includes('faktúra') ||
    q.includes('reklamaci') ||
    q.includes('reklamáci') ||
    q.includes('vratenie') ||
    q.includes('vrátenie') ||
    q.includes('vratka');

  const isTech =
    q.includes('nefunguje') ||
    q.includes('nejde') ||
    q.includes('spojit') ||
    q.includes('spojiť') ||
    q.includes('parovat') ||
    q.includes('párovať') ||
    q.includes('parovanie') ||
    q.includes('párovanie') ||
    q.includes('bluetooth') ||
    q.includes('nabija') ||
    q.includes('nabíja') ||
    q.includes('nenabija') ||
    q.includes('nenabíja') ||
    q.includes('display') ||
    q.includes('displej') ||
    q.includes('problem') ||
    q.includes('problém') ||
    q.includes('manual') ||
    q.includes('manuál');

  const isProduct =
    q.includes('hodink') ||
    q.includes('naramok') ||
    q.includes('náramok') ||
    q.includes('prsten') ||
    q.includes('prsteň') ||
    q.includes('gps') ||
    q.includes('vyber') ||
    q.includes('výber') ||
    q.includes('chcem hodinky') ||
    q.includes('aku by ste odporucili') ||
    q.includes('akú by ste odporučili') ||
    q.includes('remienok') ||
    q.includes('nahradny') ||
    q.includes('náhradný');

  if (isOrder) {
    effectiveMode = 'order';
  } else if (isTech) {
    effectiveMode = 'tech';
  } else if (isProduct) {
    effectiveMode = 'product';
  } else {
    // ak sa nič nehodí → nechaj general
    effectiveMode = 'product'; // môžeš dať aj null alebo general
  }
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
-Pri vybere produktov VZDY odporucaj vyhradne produkty znacky Carneo z e-shopu www.carneo.sk.
Nikdy neuvadzaj ako odporucanie ine znacky (Garmin, Apple, Huawei, Amazfit, Samsung a podobne).
Ak Carneo produkt pre danu poziadavku nepoznas, radsej to uprimne povedz a navrhni kontakt na Carneo podporu,
namiesto odporucania inej znacky.

Ak si nie si isty, otvorene to povedz a navrhni eskalaciu na cloveka (Carneo podpora).
`;

    let systemExtra = '';
    let searchHint = '';
    let domain: 'general' | 'products' = 'general';

    switch (effectiveMode) {
      case 'product':
  systemExtra = `
Pri otázkach na výber produktu vždy rob toto:

1) prioritne odporúčaj produkty výhradne značky Carneo,
2) NEodporúčaj žiadne iné značky (Garmin, Apple, Samsung, Suunto...),
3) interne použij produktový RAG index — ale zákazníkovi RAG nikdy nespomínaj,
4) odporuč 1 až 3 najvhodnejšie produkty,
5) názvy produktov uvádzaj presne ako v e-shope a formátuj ich pomocou <b>...</b>,
6) ak meta.url existuje → zobraz link v tvare <b><a href="URL" target="_blank">Pozrieť produkt</a></b>,
7) cenu zobrazuj ako <b>Cena: XX,XX EUR</b>,
8) ak meta.image existuje → zobraz obrázok pomocou: 
   <img src="IMAGE_URL" alt="Názov produktu" style="max-width:100%;border-radius:8px;margin:8px 0;">
9) ak URL nemáš → napíš “nájdete podľa názvu na www.carneo.sk”.

Odpoveď píš prehľadne v bodoch 1., 2., 3.:
- obrázok (ak existuje)
- tučný názov produktu
- krátky popis
- cena (tučná)
- aktívny odkaz
- 2–3 kľúčové parametre
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

        // ─────────────────────────────────────────────
    // Heuristika: je otázka dostatočne špecifická?
    // (rozpočet, GPS, pánske/dámske, šport atď.)
    // ─────────────────────────────────────────────
    const isSpecificProductQuery =
  effectiveMode === 'product' &&
  /(\b\d+\s?(eur|€)\b|\bgps\b|\bpánsk|\bpanske|\bdámsk|\bdamske|\bdetsk|\bbehu|\bbeh\b|\bplávan|\bplavani|\bcyklo)/i.test(
    question
  );

    let prompt: string;

    if (isSpecificProductQuery) {
      // Otázka je už dosť konkrétna → rovno odporuč produkty
      prompt = `Otazka zakaznika:
${question}

Kontekst (relevantne pasaze zo znalostnej baze Carneo):
${citations}

Pokyny:
Otazka uz obsahuje pomerne konkretne kriteria (napr. rozpocet, typ, GPS).
1. Hned odporuc 1 az 3 najvhodnejsie produkty znacky Carneo.
2. Pri kazdom produkte vytvor blok:
   - cislo v zozname (1., 2., 3.)
   - <b>nazov produktu</b>
   - kratky popis pre koho a na co sa hodi
   - riadok <b>Cena:</b> s cenou, ak je k dispozicii
   - riadok <b>Pozriet produkt:</b> s odkazom <a href="URL" target="_blank">Pozriet produkt</a> (ak mas URL).
3. Az NA KONCI (max 1–2 vety) pripadne navrhni, ake doplnujuce informacie by este pomohli.
4. Neodpovedaj len dalsimi otazkami – zakaznik musi hned vidiet konkretne produkty.`;
    } else {
      // Menej konkrétna otázka → môžeš si vypýtať doplnenie
      prompt = `Otazka zakaznika:
${question}

Kontekst (relevantne pasaze zo znalostnej baze Carneo):
${citations}

Pokyny:
- Pouzi informacie z pasazi vyssie.
- Odpovedaj vecne, v kratkych odstavcoch.
- Pri rezime "vyber produktu" uprednostnuj produkty Carneo a pouzi meta.url ako odkaz, ak je k dispozicii.
- Ak chyba dolezita informacia (napr. rozpocet, typ pouzitia, cislo objednavky), slusne si ju vypytaj, ale zaroven skus na zaklade dostupnych udajov aspon orientacne poradit.`;
    }

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
        file: (h as any).meta?.file || (h as any).meta?.name,
        id: h.id,
        url: (h as any).meta?.url
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
