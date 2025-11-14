import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';
import { XMLParser } from 'fast-xml-parser';

// URL Heureka feedu zo Shoptetu
const FEED_URL = 'https://www.carneo.sk/heureka/export/products.xml';

// kam uložíme RAG index s produktmi
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'carneo-products-index.json');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ─────────────────────────────────────────────────────────────
// pomocné funkcie
// ─────────────────────────────────────────────────────────────

async function fetchXml(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch XML feed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function parseProducts(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true
  });

  const data = parser.parse(xmlString);

  // Heureka feed: SHOP > SHOPITEM[]
  const items = data.SHOP?.SHOPITEM;
  if (!items || (Array.isArray(items) && items.length === 0)) {
    throw new Error('No SHOPITEM nodes found in feed');
  }

  const arr = Array.isArray(items) ? items : [items];

  const products = arr.map((item) => {
    const id =
      item.ITEM_ID ||
      item.ID ||
      item.PRODUCTNO ||
      item.EAN ||
      undefined;

    const name = item.PRODUCT || item.PRODUCTNAME || '';
    const url = item.URL || '';
    const price = item.PRICE_VAT || item.PRICE || '';
    const category = item.CATEGORYTEXT || '';
    const manufacturer = item.MANUFACTURER || '';
    const description = item.DESCRIPTION || '';
    const params = item.PARAM || [];
    const image =item.IMGURL ||
  item.IMGURL_ALTERNATIVE ||
  (Array.isArray(item.IMGURL_ALTERNATIVE) ? item.IMGURL_ALTERNATIVE[0] : '') ||
  '';

    // PARAM môže byť objekt alebo pole → spravíme text
    let paramText = '';
    if (Array.isArray(params)) {
      paramText = params
        .map((p) => `${p.PARAM_NAME || ''}: ${p.VAL || ''}`)
        .filter(Boolean)
        .join('\n');
    } else if (params && typeof params === 'object') {
      paramText = `${params.PARAM_NAME || ''}: ${params.VAL || ''}`;
    }

    // Text pre RAG (embedding)
    const textParts = [
      name && `Názov: ${name}`,
      manufacturer && `Značka: ${manufacturer}`,
      category && `Kategória: ${category}`,
      price && `Cena: ${price} EUR`,
      paramText && `Parametre:\n${paramText}`,
      description && `Popis:\n${description}`
    ].filter(Boolean);

    const fullText = textParts.join('\n\n');

    return {
      id: id || name,
      text: fullText,
      meta: {
        id: id || null,
        name,
        url,
        price,
        category,
        manufacturer
        image
      }
    };
  });

  return products;
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING – s orezom textu aby neprekročil limity modelu!
// ─────────────────────────────────────────────────────────────

async function embedDocuments(docs) {
  console.log(`➡ Vytváram embeddingy pre ${docs.length} produktov...`);

  const BATCH_SIZE = 64;
  const out = [];
  const MAX_CHARS = 4000; // bezpečný limit (cca 1500 tokenov)

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);

    const inputTexts = batch.map((d) => {
      const txt = d.text || '';
      return txt.length > MAX_CHARS ? txt.slice(0, MAX_CHARS) : txt;
    });

    console.log(`  · Batch ${i}–${i + batch.length - 1}`);

    const resp = await openai.embeddings.create({
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      input: inputTexts
    });

    const vectors = resp.data.map((d) => d.embedding);

    batch.forEach((doc, idx) => {
      out.push({
        id: doc.id,
        embedding: vectors[idx],
        text: doc.text, // originál (neorezaný) text
        meta: doc.meta
      });
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// hlavná funkcia
// ─────────────────────────────────────────────────────────────

async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY nie je nastavený v env.');
    }

    // ensure data folder
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    console.log('➡ Sťahujem XML feed zo Shoptetu...');
    const xml = await fetchXml(FEED_URL);

    console.log('➡ Parsujem produkty...');
    const products = parseProducts(xml);
    console.log(`   Načítaných produktov: ${products.length}`);

    console.log('➡ Vytváram embeddingový index (RAG) pre produkty...');
    const indexed = await embedDocuments(products);

    console.log(`➡ Ukladám index do ${OUTPUT_FILE} ...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(indexed, null, 2), 'utf-8');

    console.log('✅ Hotovo – carneo-products-index.json vytvorený.');
  } catch (err) {
    console.error('❌ Chyba pri importe produktov:', err);
    process.exit(1);
  }
}

main();
