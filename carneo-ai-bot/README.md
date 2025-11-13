# Carneo AI bot — Setup

1) Node 20+, pnpm alebo npm.

2) `cp .env.example .env` a doplniť `OPENAI_API_KEY`.

3) Ingest znalostí (PDF/DOCX/TXT):
   ```
   pnpm install
   pnpm ingest ./docs/navod_k_hodinkam.pdf ./docs/faq_servis.docx ./docs/podmienky.txt
   ```

4) Spustenie servera:
   ```
   pnpm dev
   ```

5) Vloženie widgetu do Shoptet šablóny (patričný HTML blok), napr.:
   ```html
   <script defer src="https://YOUR_HOST/public/widget.js"></script>
   ```

6) Overenie: otvoriť web, kliknúť na bublinu **AI** a položiť technickú otázku.

## Poznámky
- Pre produkciu odporúčame vymeniť `data/index.json` za **pgvector** (Postgres) alebo Pinecone/Qdrant.
- Pri odpovediach model dostáva najrelevantnejšie pasáže (RAG), čím sa minimalizuje halucinácia.
- Ak pripojíte Shoptet API, doplňte funkcie v `src/shoptet.ts` a rozšírte prompt o živé dáta (dostupnosť, varianty, stav objednávky).
