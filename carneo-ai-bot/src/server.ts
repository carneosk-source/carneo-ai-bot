import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import { search } from './rag.js';
import { importSupportEmailsOnce } from './email-import.js';
import cron from 'node-cron';
import { importEmailsFromImap } from './imap-client';
import multer from 'multer';
import { simpleParser } from 'mailparser'; // ak už máš
// import pdf-parse ak chceš parsovať PDF:
import pdfParse from 'pdf-parse';

const upload = multer({
  dest: path.join(process.cwd(), 'uploads')
});

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static('public'));

// Root – jednoduchý text, použiteľný aj ako wake endpoint
app.get('/', (_req, res) => {
  res.send('Carneo AI Bot API is running.');
});

const TECH_RAG_FILE = path.join(process.cwd(), 'data', 'rag-tech.jsonl');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';

const LOG_FILE = path.join(process.cwd(), 'data', 'chat-logs.jsonl');

function readChatLogs(): any[] {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const out: any[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignoruj pokazený riadok
      }
    }
    return out;
  } catch (e) {
    console.error('Cannot read chat logs:', e);
    return [];
  }
}
function appendToTechRag(doc: any) {
  const dir = path.dirname(TECH_RAG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(doc) + '\n';
  fs.appendFileSync(TECH_RAG_FILE, line, 'utf8');
}

function appendChatLog(entry: any) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry
      }) + '\n';

    fs.appendFile(LOG_FILE, line, (err) => {
      if (err) {
        console.error('Chat log write error:', err);
      }
    });
  } catch (err) {
    console.error('Chat log serialize error:', err);
  }
}

async function extractTextFromFile(filePath: string, originalName: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const lower = originalName.toLowerCase();

  if (lower.endsWith('.pdf')) {
    const pdfData = await pdfParse(buf);
    return pdfData.text || '';
  }

  // jednoduchá podpora .txt
  if (lower.endsWith('.txt')) {
    return buf.toString('utf8');
  }

  // fallback – tiež ako text
  return buf.toString('utf8');
}

async function addTechDocToRag(opts: {
  title: string;
  text: string;
  sourceType: 'manual' | 'tech-note';
  fileName?: string;
}) {
  const { title, text, sourceType, fileName } = opts;
  console.log('Adding tech document:', title, 'source:', sourceType);

  const textForEmbedding = `Title: ${title}\nSource: ${sourceType}\n\n${text.slice(0, 5000)}`;

  const embResp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: textForEmbedding
  });

  const embedding = embResp.data[0].embedding;

  const doc = {
    id: `tech-${sourceType}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    text: textForEmbedding,
    embedding,
    meta: {
      sourceType,
      domain: 'tech',
      title,
      fileName: fileName || null,
      createdAt: new Date().toISOString()
    }
  };

  appendToTechRag(doc);
}
app.post(
  '/api/admin/rag-tech-upload-manuals',
  upload.array('files', 20),
  async (req, res) => {
    try {
      const keyFromBody = (req.body && req.body.adminKey) as string | undefined;
      const keyFromQuery = req.query.adminKey as string | undefined;
      const providedKey = keyFromBody || keyFromQuery;

      if (!ADMIN_KEY || providedKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const files = (req.files || []) as Express.Multer.File[];
      if (!files.length) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const results: any[] = [];

      for (const f of files) {
        const text = await extractTextFromFile(f.path, f.originalname);
        if (!text.trim()) {
          results.push({ file: f.originalname, ok: false, reason: 'empty-text' });
          continue;
        }

        await addTechDocToRag({
          title: f.originalname,
          text,
          sourceType: 'manual',
          fileName: f.originalname
        });

        results.push({ file: f.originalname, ok: true });
        // po spracovaní môžeš dočasný súbor zmazať
        fs.unlink(f.path, () => {});
      }

      res.json({ ok: true, files: results });
    } catch (err: any) {
      console.error('rag-tech-upload-manuals error:', err);
      res.status(500).json({ ok: false, error: err?.message || 'Server error' });
    }
  }
);

app.post('/api/admin/rag-tech-add-note', async (req, res) => {
  try {
    const body = req.body || {};
    const keyFromBody = body.adminKey as string | undefined;
    const keyFromQuery = req.query.adminKey as string | undefined;
    const providedKey = keyFromBody || keyFromQuery;

    if (!ADMIN_KEY || providedKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const title = (body.title || '').toString().trim() || 'Poznámka technika';
    const text = (body.text || '').toString();

    if (!text.trim()) {
      return res.status(400).json({ error: 'Empty text' });
    }

    await addTechDocToRag({
      title,
      text,
      sourceType: 'tech-note'
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('rag-tech-add-note error:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Server error' });
  }
});


app.post('/api/ask', async (req, res) => {
  try {
    const { question, mode, sessionId } = req.body as {
      question?: string;
      mode?: 'product' | 'order' | 'tech' | null;
      sessionId?: string | null;
    };

    // 1) Kontrola otázky
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }

    // 🔹 stabilný sessionId na serveri
    const sid =
      typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.trim()
        : `srv-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;

    // ------------------------------------------
    // AUTOMATICKÉ ROZPOZNANIE TYPU OTÁZKY
    // ------------------------------------------
    let effectiveMode: 'product' | 'order' | 'tech' | null = mode ?? null;

    // Ak používateľ neklikol žiadnu možnosť vo widgete,
    // automaticky odhadneme podľa textu otázky.
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
        /\bhodink|\bnaramok|\bnáramok|\bsmart\s?prsten|\bsmart\s?prsteň|\bprsten|\bprsteň|\bring|\bpay\s?ring|\bplatobny\s?prsten|\bplatobný\s?prsteň|\breproduktor|\bspeaker|\bglobus\b|\bnabytok\b/i.test(
          q
        ) ||
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
        // ak sa nič nehodí → defaultne product (môžeš dať aj null/general)
        effectiveMode = 'product';
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
- Pri vybere produktov VZDY odporucaj vyhradne produkty znacky Carneo z e-shopu www.carneo.sk.
Nikdy neuvadzaj ako odporucanie ine znacky (Garmin, Apple, Huawei, Amazfit, Samsung a podobne).
Ak Carneo produkt pre danu poziadavku nepoznas, radsej to uprimne povedz a navrhni kontakt na Carneo podporu,
namiesto odporucania inej znacky.

Ak si nie si isty, otvorene to povedz a navrhni eskalaciu na cloveka (Carneo podpora).
`;

    let systemExtra = '';
    let searchHint = '';
    let domain: 'general' | 'products' | 'tech' = 'general';

    switch (effectiveMode) {
      case 'product':
        domain = 'products';
        systemExtra = `
Pri otázkach na výber produktu vždy rob toto:

1) prioritne odporúčaj produkty výhradne značky Carneo,
2) NEodporúčaj žiadne iné značky (Garmin, Apple, Samsung, Suunto...),
3) interne použij produktový RAG index — ale zákazníkovi RAG nikdy nespomínaj,
4) odporuč 1 až 3 najvhodnejšie produkty,
5) názvy produktov uvádzaj presne ako v e-shope a formátuj ich pomocou <b>...</b>,
6) ak meta.url existuje → zobraz JEDEN link v tvare:<b><a href="URL" target="_blank">Pozrieť produkt</a></b>
7) cenu zobrazuj ako <b>Cena: XX,XX EUR</b>,
8) ak meta.image existuje → zobraz obrázok pomocou: 
   <img src="IMAGE_URL" alt="Názov produktu" style="max-width:100%;border-radius:8px;margin:8px 0;">
9) ak URL nemáš → napíš “nájdete podľa názvu na www.carneo.sk”.
10) ak znalostná báza obsahuje viac farebných variantov toho istého modelu
    (napr. Sand Grey / Black), a zmestia sa do limitu 1–3 odporúčaní,
    zobraz tieto varianty ako samostatné body (1., 2., 3.) v odpovedi.

Ďalšie dôležité pravidlá:
- ak zákazník píše o „pánskych“ hodinkách (pánske, panske, pánsky), NIKDY neodporúčaj:
  - detské hodinky (názov obsahuje „Detské“, „GuardKid“, „Tiny“, „ULTRA“),
  - GPS lokátor pre psov (názov obsahuje „DogSAFE“, „lokátor pre domácich miláčikov“).
- ak zákazník píše o detských hodinkách, uprednostni modely GuardKid a neodporúčaj DogSAFE lokátor.
- ak zákazník hľadá GPS pre psa alebo domáceho miláčika, odporúčaj výhradne DogSAFE lokátor, NIE hodinky.

Odpoveď píš prehľadne v bodoch 1., 2., 3.:
- obrázok (ak existuje)
- tučný názov produktu
- krátky popis
- cena (tučná)
- aktívny odkaz
- 2–3 kľúčové parametre
`;
        searchHint = 'Vyber produktu Carneo, pouzi produktovy index.';
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
Pri TECH dotazoch si expert technický poradca Carneo.

VŽDY používaj EXPERT ŠTÝL odpovede:

1) ÚVOD
- 1–2 vety, čo je pravdepodobná príčina problému (bez omáčky).
- Napíš, či ide skôr o chybu nastavenia, signálu, appky alebo hardvéru.

2) DETAILNÝ POSTUP KROK ZA KROKOM
- Odpoveď štruktúruj číslovaním 1., 2., 3., 4. ...
- V každom kroku uveď presné a konkrétne úkony:
  - konkrétne názvy tlačidiel/menu v aplikácii,
  - čo má zákazník vidieť (príklad: "v menu nájdete položku **Zariadenia > Pridať zariadenie**"),
  - pri telefónoch spomeň Android/iOS, ak je rozdiel.
- Nepíš všeobecné frázy ako „skúste niečo“ – buď konkrétny.

3) KONTROLA A DOPLŇUJÚCE ÚDAJE
- Ak niečo závisí od modelu / verzie OS / verzie appky, slušne sa opýtaj:
  - model hodiniek,
  - typ telefónu + verzia OS,
  - verzia aplikácie,
  - či hodinky používajú SIM, IMEI, atď.
- Píš to v štýle:
  "Prosím doplňte: 1) model telefónu, 2) verzia OS, 3) názov a verzia aplikácie."

4) ZÁVER + ESKALÁCIA
- Na konci pridaj sekciu „Ak toto nepomôže“:
  - odporuč kontakt na Carneo technickú podporu / servis,
  - napíš, aby si pripravil: model hodiniek, IMEI, číslo objednávky, typ telefónu a stručný popis problému.
- Ak si nie si istý, otvorene povedz, že ďalšia diagnóza je už na technikovi.

Formát:
- Používaj krátke odstavce a prehľadné bodovanie.
- Odpovedaj v jazyku otázky (slovenčina/čeština).`;
        searchHint = 'Téma: technické dotazy a návody k produktom Carneo. Použi TECH databázu (maily, expert poznámky, návody).';
        domain = 'tech';
        break;

      default:
        searchHint = '';
        domain = 'general';
        break;
    }

        // ------------------------------------------------
    // CONTEXT / CONTINUATION – doplňujúce otázky
    // ------------------------------------------------
    const CONTINUATION_PHRASES = [
      'aj v inej farbe',
      'v inej farbe',
      'je dostupny aj',
      'je dostupný aj',
      'je aj v',
      'existuje aj v',
      'existuje aj verzia',
      'je aj verzia',
      'aj v čiernej',
      'aj v ciernej',
      'aj v bielej',
      'a ake farby',
      'aké farby',
      'v akej farbe',
      'v akej farbe je',
      'má aj iné farby',
      'ma aj ine farby',
      'ďalšia farba',
      'dalsia farba',
      'aj iná farba',
      'aj ina farba',
      'aj v inej veľkosti',
      'aj v inej velkosti',
      'existujú aj iné farby',
      'existuju aj ine farby'
    ];

    function isContinuationQuestion(q: string): boolean {
      const x = q.toLowerCase();
      return CONTINUATION_PHRASES.some(p => x.includes(p));
    }

    // načítaj posledný log pre daný sessionId (ak existuje)
    let lastSessionLog: any | null = null;
    try {
      const allLogs = readChatLogs();
      const forSession = allLogs.filter(l => l.sessionId === sid);
      if (forSession.length > 0) {
        lastSessionLog = forSession[forSession.length - 1];
      }
    } catch (e) {
      console.error('Cannot read last session log:', e);
    }

    const isContinuation =
      effectiveMode === 'product' &&
      !!lastSessionLog &&
      isContinuationQuestion(question);


        const MEN_CATEGORY_REGEX =
      /(pánsk|panske|pansky|muž|muz|men|man|hodinky pánske|pánske hodinky|panske hodinky|smart hodinky pánske|pánske smart hodinky)/i;

    const WOMEN_CATEGORY_REGEX =
      /(dámsk|damsk|dámske|damske|hodinky dámske|dámske hodinky|smart hodinky dámske|dámske smart hodinky|women|lady|ladies)/i;

    const KIDS_CATEGORY_REGEX =
      /(detské|detske|detsk|guardkid|tiny|ultra|pre deti|pre-deti|kids|junior|child)/i;

    const PET_CATEGORY_REGEX =
      /(dogsafe|lokator|lokátor|gps lokator|pre psa|pre psov|pre domacich milacikov|pet|zviera)/i;
    
   // =========================
// RAG vyhladavanie
// =========================

// ak je to pokračovanie, snažíme sa držať sa posledného produktu
let queryForSearch: string;

let baseProductName: string | null = null;
if (isContinuation && lastSessionLog && Array.isArray(lastSessionLog.ragHits)) {
  const lastProductHit = lastSessionLog.ragHits[0];
  if (lastProductHit && lastProductHit.name) {
    baseProductName = String(lastProductHit.name);
  }
}

if (isContinuation && baseProductName) {
  // Doplňujúca otázka – sústreď sa na varianty / farby toho istého modelu
  queryForSearch = `
Varianty, farby alebo verzie produktu Carneo: ${baseProductName}
Doplňujúca otázka zákazníka: ${question}
`;
} else {
  // bežný dopyt
  queryForSearch = `${searchHint ? searchHint + '\n' : ''}${question}`;
}

let hits = await search(openai, queryForSearch, 8, { domain });

// Debug výpis – nechaj, pomôže pri ladení
console.log('🔍 RAG DEBUG QUERY:', queryForSearch);
hits.forEach((h: any, i: number) => {
  console.log(
    ` #${i + 1} | score=${h.score?.toFixed?.(3)} | name=${h.meta?.name} | url=${h.meta?.url}`
  );
});

// -----------------------------------------------
// Pomocné funkcie – názov, URL, kategória
// -----------------------------------------------
function getName(h: any): string {
  return (h.meta?.name || h.meta?.title || '').toString();
}

function getUrl(h: any): string {
  return (h.meta?.url || '').toString().toLowerCase();
}

function getCategoryMeta(h: any): string {
  return (
    h.meta?.category ||
    h.meta?.categories ||
    ''
  ).toString().toLowerCase();
}

// -----------------------------------------------
// Klasifikácia produktu podľa URL + názvu + kategórie
// -----------------------------------------------
function classifyProduct(h: any) {
  const name = getName(h).toLowerCase();
  const url = getUrl(h);
  const cat = getCategoryMeta(h);
  const blob = `${name} ${url} ${cat}`;

  const isMen =
    // primárne podľa URL
    /panske-smart-hodinky|hodinky-panske/.test(url) ||
    // alebo podľa textu, ale iba ak to NIE je jasne dámske
    (/(pánsk|panske|pansky)/.test(blob) &&
      !/(dámsk|damsk|dámske|damske)/.test(blob));

  const isWomen =
    /damske-smart-hodinky|hodinky-damske/.test(url) ||
    /(dámsk|damsk|dámske|damske|lady|women)/.test(blob);

  const isKids =
    /guardkid/.test(blob) ||
    /detske-smart-hodinky|detske-gps-hodinky/.test(url) ||
    /(detské|detske|pre deti)/.test(blob);

  const isPet =
    /dogsafe/.test(blob) ||
    /gps-lokator-pre-psa|lokator-pre-domacich-milacikov/.test(url);

  const hasGps = /gps/.test(blob);

  return { isMen, isWomen, isKids, isPet, hasGps };
}

// --------------------------------------------------------
// CATEGORY LOCKDOWN – tvrdý filter podľa dotazu
// --------------------------------------------------------
function applyCategoryLockdown(hitsIn: any[], question: string) {
  const q = question.toLowerCase();
  let out = hitsIn;

  const wantsMen = /pánsk|panske|pansky/.test(q);
  const wantsWomen = /dámsk|damsk|damsky/.test(q);
  const wantsKids = /detsk|guardkid|tiny|pre deti|dieťa|dieta/.test(q);
  const wantsPet = /pes|psa|psovi|dogsafe|zviera/.test(q);
  const gpsRequired = /\bgps\b/.test(q);

  function filterStrict(
    predicate: (p: ReturnType<typeof classifyProduct>) => boolean
  ) {
    const filtered = out.filter(h => predicate(classifyProduct(h)));
    // Ak by nič nenašlo, radšej vrátime pôvodný zoznam (nech radšej poradí niečo,
    // než aby tvrdil, že nič neexistuje)
    return filtered.length > 0 ? filtered : out;
  }

  if (wantsMen) {
    // 1) vyber iba pánske modely
    out = filterStrict(p => p.isMen);

    // 2) poistka – ak by aj tak ostali vyslovene dámske/detské/pet, vyhoď ich
    out = out.filter(h => {
      const p = classifyProduct(h);
      return p.isMen || (!p.isWomen && !p.isKids && !p.isPet);
    });
  } else if (wantsWomen) {
    out = filterStrict(p => p.isWomen);
  } else if (wantsKids) {
    out = filterStrict(p => p.isKids);
  } else if (wantsPet) {
    out = filterStrict(p => p.isPet);
  }

  // Ak dotaz obsahuje GPS → nechaj len modely s GPS
  if (gpsRequired) {
    const gpsHits = out.filter(h => classifyProduct(h).hasGps);
    if (gpsHits.length > 0) {
      out = gpsHits;
    }
  }

  return out;
}

// Použiť lockdown na výsledky z RAG
hits = applyCategoryLockdown(hits, question);

// --------------------------------------------------
// CITÁCIE (až teraz, keď máme finálne hits)
// --------------------------------------------------
const citations = hits
  .map((h: any, i: number) => {
    const meta: any = h.meta || {};
    const urlPart = meta.url ? ` URL: ${meta.url}` : '';
    const imagePart = meta.image ? ` IMAGE: ${meta.image}` : '';
    return `[[${i + 1}]] ${meta.name || meta.file || 'doc'}: ${h.text.slice(
      0,
      180
    )}...${urlPart}${imagePart}`;
  })
  .join('\n');
    
// ...
    // Heuristika: je otázka dostatočne špecifická?
    const isSpecificProductQuery =
      effectiveMode === 'product' &&
      /(\b\d+\s?(eur|€)\b|\bgps\b|\bpánsk|\bpanske|\bdámsk|\bdamske|\bdetsk|\bbehu|\bbeh\b|\bplávan|\bplavani|\bcyklo)/i.test(
        question
      );

    // Ak existuje aspoň 1 RAG hit v produktovom režime → špeciálne pravidlo
    if (effectiveMode === 'product' && hits.length > 0) {
      systemExtra += `
Ak znalostná databáza obsahuje aspoň 1 produktový výsledok,
nikdy netvrd', že produkt Carneo neexistuje.
Namiesto toho ho normálne odporuč.
`;
    }

    let prompt: string;

    if (isSpecificProductQuery) {
      prompt = `Otazka zakaznika:
${question}

Kontekst (relevantne pasaze zo znalostnej baze Carneo):
${citations}

Pokyny:
Otazka uz obsahuje pomerne konkretne kriteria (napr. rozpocet, typ, GPS).
1. Hned odporuc 1 az 3 najvhodnejsie produkty znacky Carneo.
   Ak ide o konkretny model, ktory ma viac farebnych variantov
   v poskytnutom kontexte (napr. Sand Grey, Black),
   zobraz 2–3 tieto farebne varianty ako samostatne body (1., 2., 3.).
2. Pre KAZDY odporucany produkt pouzi presne TENTO HTML format:
   - cislo v zozname (1., 2., 3.)
   - <b>{NAZOV PRODUKTU}</b><br>
   - ak je v pasazi "IMAGE: ...", vloz samostatny riadok:<img src="{IMAGE_URL}" alt="{NAZOV PRODUKTU}" style="max-width:100%;border-radius:8px;margin:8px 0;"><br>
   - kratky popis pre koho a na co sa hodi
   - na samostatny riadok napis:
   <b>Cena: {CENA} EUR</b><br>
   - na dalsi riadok napis:
   <b><a href="{URL}" target="_blank">Pozriet produkt</a></b><br>
  (NEpridávaj žiadny ďalší text pred linkom)
3. Az NA KONCI (max 1–2 vety) pripadne navrhni, ake doplnujuce informacie by este pomohli.
4. Neodpovedaj len dalsimi otazkami – zakaznik musi hned vidiet konkretne produkty.`;
    } else {
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

    // Tu MUSÍ vzniknúť finálny system prompt (až po všetkých úpravách systemExtra)
    const system = systemExtra ? `${baseSystem}\n${systemExtra}` : baseSystem;

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

    // 🔹 uloženie logu konverzácie
    appendChatLog({
      sessionId: sid,
      question,
      answer,
      modeFromClient: mode ?? null,
      effectiveMode,
      domain,
      ragHits: hits.map((h: any) => ({
        id: h.id,
        name: h.meta?.name || h.meta?.file,
        url: h.meta?.url,
        score: h.score
      }))
    });

    res.json({
      answer,
      sources: hits.map((h: any) => ({
        file: h.meta?.file || h.meta?.name,
        id: h.id,
        url: h.meta?.url
      }))
    });
  } catch (error) {
    console.error('Ask error:', error);
    try {
      appendChatLog({
        sessionId: (req.body && req.body.sessionId) || 'unknown',
        question: req.body?.question,
        error: String(error)
      });
    } catch {}
    res.status(500).json({ error: 'Server error' });
  }
});

// ADMIN – prehľad logov (čítanie + štatistiky, podklad pre admin UI)
app.get('/api/admin/chat-logs', async (req, res) => {
  try {
    const { mode, search, limit } = req.query;
    const key = String(req.query.adminKey || '');

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fs.existsSync(LOG_FILE)) {
      return res.json([]);
    }

    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Najprv načítame všetko a oddelíme rating eventy od normálnych logov
    const logs: any[] = [];
    const ratingMap = new Map<string, { rating: string; note?: string }>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Rating event (z /api/admin/rate)
        if (entry.type === 'rating' && entry.sessionId && entry.targetTs) {
          const key = `${entry.sessionId}|${entry.targetTs}`;
          ratingMap.set(key, {
            rating: entry.rating,
            note: entry.note
          });
          continue;
        }

        // Bežný chat log
        logs.push(entry);
      } catch {
        // ignoruj poškodené riadky
      }
    }

    // Doplníme adminRating / adminNote podľa ratingMap
    logs.forEach((entry) => {
      if (!entry.sessionId || !entry.ts) return;
      const key = `${entry.sessionId}|${entry.ts}`;
      const r = ratingMap.get(key);
      if (r) {
        entry.adminRating = r.rating;
        entry.adminNote = r.note || '';
      }
    });

    // Filtrovanie podľa query
    let out = logs.slice().sort((a, b) =>
      a.ts > b.ts ? -1 : 1
    );

    if (mode && typeof mode === 'string') {
      out = out.filter((e) => {
        const eff = e.effectiveMode || e.modeFromClient || '';
        return eff === mode;
      });
    }

    if (search && typeof search === 'string' && search.trim()) {
      const s = search.toLowerCase();
      out = out.filter((e) => {
        const blob = `${e.question || ''}\n${e.answer || ''}\n${
          e.error || ''
        }`.toLowerCase();
        return blob.includes(s);
      });
    }

    const lim =
      typeof limit === 'string' ? parseInt(limit, 10) || 200 : 200;
    out = out.slice(0, lim);

    res.json(out);
  } catch (err) {
    console.error('admin chat-logs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: PREHĽAD POSLEDNÝCH CHATOV ============
// ============ ADMIN: PREHĽAD POSLEDNÝCH CHATOV ============
app.get('/admin/chat-logs', (req, res) => {
  const token = req.query.token as string | undefined;
  const adminToken = process.env.ADMIN_LOGS_TOKEN;

  if (!adminToken) {
    return res
      .status(500)
      .json({ error: 'ADMIN_LOGS_TOKEN nie je nastavený na serveri' });
  }

  if (token !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  fs.readFile(LOG_FILE, 'utf8', (err, data) => {
    if (err) {
      if ((err as any).code === 'ENOENT') {
        return res.json([]);
      }
      console.error('Read log error:', err);
      return res.status(500).json({ error: 'Log read error' });
    }

    const lines = data
      .split('\n')
      .filter((l) => l.trim().length > 0);

    const last = lines.slice(-100).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    res.json(last);
  });
});

// ==========================
//  ADMIN API – logy a štatistiky
// ==========================

function requireAdminKey(req: any, res: any, next: any) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({ error: 'ADMIN_KEY is not configured' });
  }

  const fromQuery = (req.query.key as string) || '';
  const fromHeader = (req.headers['x-admin-key'] as string) || '';
  const provided = fromQuery || fromHeader;

  if (!provided || provided !== adminKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// GET /api/admin/logs?key=...&limit=100&mode=product&q=hodinky
app.get('/api/admin/logs', requireAdminKey, (req, res) => {
  try {
    const all = readChatLogs();

    const limit = Math.min(
      500,
      Math.max(1, parseInt(String(req.query.limit || '200'), 10))
    );
    const modeFilter = (req.query.mode as string) || '';
    const q = ((req.query.q as string) || '').toLowerCase();

    let filtered = all;

    if (modeFilter) {
      filtered = filtered.filter(
        (e) =>
          (e.effectiveMode && String(e.effectiveMode) === modeFilter) ||
          (e.modeFromClient && String(e.modeFromClient) === modeFilter)
      );
    }

    if (q) {
      filtered = filtered.filter((e) => {
        const text =
          (e.question || '') + ' ' + (e.answer || '');
        return text.toLowerCase().includes(q);
      });
    }

    filtered = filtered.sort(
      (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()
    );

    res.json(filtered.slice(0, limit));
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).json({ error: 'Cannot read logs' });
  }
});

// jednoduché štatistiky – počty podľa režimu atď.
app.get('/api/admin/stats', requireAdminKey, (req, res) => {
  try {
    const all = readChatLogs();

    const byMode: Record<string, number> = {};
    const total = all.length;

    for (const e of all) {
      const m = e.effectiveMode || e.modeFromClient || 'unknown';
      byMode[m] = (byMode[m] || 0) + 1;
    }

    res.json({
      total,
      byMode
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Cannot compute stats' });
  }
});

// ADMIN – info o tech RAG súbore (emaily)
app.get('/api/admin/rag-tech-info', requireAdminKey, (req, res) => {
  try {
    if (!fs.existsSync(TECH_RAG_FILE)) {
      return res.json({
        exists: false,
        sizeBytes: 0,
        records: 0
      });
    }

    const stat = fs.statSync(TECH_RAG_FILE);
    const raw = fs.readFileSync(TECH_RAG_FILE, 'utf-8');

    const records = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean).length;

    res.json({
      exists: true,
      sizeBytes: stat.size,
      records
    });
  } catch (err) {
    console.error('rag-tech-info error:', err);
    res.status(500).json({ error: 'Cannot read rag-tech file' });
  }
});

// ADMIN – stiahnutie tech RAG súboru (emaily)
app.get('/api/admin/rag-tech-download', requireAdminKey, (req, res) => {
  try {
    if (!fs.existsSync(TECH_RAG_FILE)) {
      return res.status(404).json({ error: 'rag-tech file not found' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="rag-tech.jsonl"');

    const stream = fs.createReadStream(TECH_RAG_FILE);
    stream.on('error', (err) => {
      console.error('rag-tech-download stream error:', err);
      if (!res.headersSent) {
        res.status(500).end('Read error');
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error('rag-tech-download error:', err);
    res.status(500).json({ error: 'Cannot stream rag-tech file' });
  }
});

// ADMIN – IMAP import
app.get('/api/admin/import-emails', requireAdminKey, async (req, res) => {
  try {
    await importEmailsFromImap();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed' });
  }
});

// ADMIN – manuálny import support e-mailov do tech knowledge base
app.post('/api/admin/import-support-emails', requireAdminKey, async (req, res) => {
  try {
    const { limit } = req.body || {};
    const max = typeof limit === 'number' && limit > 0 && limit <= 500 ? limit : 50;
    const result = await importSupportEmailsOnce(max);

    res.json({
      ok: true,
      imported: result.imported,
      file: 'data/support-emails.jsonl'
    });
  } catch (err: any) {
    console.error('support email import error:', err);
    res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});

// ADMIN – uloženie manuálneho hodnotenia odpovede (C3)
app.post('/api/admin/rate', requireAdminKey, (req, res) => {
  try {
    const { sessionId, ts, rating, note } = req.body || {};

    if (!sessionId || !ts || !rating) {
      return res.status(400).json({
        error: 'Missing sessionId / ts / rating'
      });
    }

    if (rating !== 'good' && rating !== 'bad') {
      return res.status(400).json({
        error: 'rating must be "good" or "bad"'
      });
    }

    appendChatLog({
      type: 'rating',
      sessionId,
      targetTs: ts,
      rating,
      note: note || null
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('admin rate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ───────────────────────────────
// CRON JOB – import IMAP emailov raz denne
// ───────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('CRON: Spúšťam IMAP import...');
  try {
    await importEmailsFromImap();
  } catch (e) {
    console.error('CRON IMAP error:', e);
  }
});

// Zdravie
app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Carneo AI bot bezi na http://localhost:${port}`);
});
