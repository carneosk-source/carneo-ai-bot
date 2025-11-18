import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';

const TECH_RAG_FILE = path.join(process.cwd(), 'data', 'rag-tech.jsonl');
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function appendToTechRag(entry: any) {
  const line = JSON.stringify(entry) + '\n';
  const dir = path.dirname(TECH_RAG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(TECH_RAG_FILE, line);
}

export async function importEmailsFromImap() {
  const host = process.env.SUPPORT_IMAP_HOST;
  const port = Number(process.env.SUPPORT_IMAP_PORT || 993);
  const user = process.env.SUPPORT_IMAP_USER;
  const pass = process.env.SUPPORT_IMAP_PASS;
  const folder = process.env.SUPPORT_IMAP_FOLDER || 'SENT';

  if (!host || !user || !pass) {
    console.error('IMAP credentials missing!');
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing – nemôžem počítať embeddingy pre tech e-maily.');
    return;
  }

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass }
  });

  try {
    console.log('Connecting to IMAP...');
    await client.connect();

    console.log(`Opening folder: ${folder}`);
    await client.mailboxOpen(folder);

    // posledných 200 správ zo SENT
    const messages = client.fetch(
      { limit: 200, reverse: true },
      { source: true, envelope: true, internalDate: true }
    );

    for await (const msg of messages) {
      const parsed = await simpleParser(msg.source);

      const subject = parsed.subject || '';
      const body = (parsed.text || parsed.html || '').trim();

      if (!body) continue;

      // text, ktorý pôjde do embeddingu (skrátime, aby to nebolo obrovské)
      const textForEmbedding = body.substring(0, 3000);

      // Vypočítame embedding pre tento e-mail
      let embedding: number[] = [];
      try {
        const embResp = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: textForEmbedding
        });
        embedding = embResp.data[0].embedding;
      } catch (e) {
        console.error('Embedding error for email:', subject, e);
        continue; // tento e-mail vynecháme, aby sme nekazili index
      }

      // Uložíme do RAG súboru v tvare kompatibilnom so search()
      appendToTechRag({
        id: `email-${msg.uid || Date.now()}`,
        text: textForEmbedding,
        embedding,
        meta: {
          subject,
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          date:
            parsed.date instanceof Date
              ? parsed.date.toISOString()
              : msg.internalDate?.toISOString?.() || new Date().toISOString(),
          domain: 'tech',
          sourceType: 'email'
        }
      });
    }

    console.log('IMAP import completed.');
  } catch (err) {
    console.error('IMAP import error:', err);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
