import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';

const TECH_RAG_FILE = path.join(process.cwd(), 'data', 'rag-tech.jsonl');
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function appendToTechRag(doc: any) {
  const dir = path.dirname(TECH_RAG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(TECH_RAG_FILE, JSON.stringify(doc) + '\n');
}

/**
 * Import posledných "limit" e-mailov z IMAP foldera
 * (typicky INBOX.Sent) a uloží ich ako tech RAG dokumenty.
 */
export async function importEmailsFromImap(limit = 200) {
  const host = process.env.SUPPORT_IMAP_HOST;
  const port = Number(process.env.SUPPORT_IMAP_PORT || 993);
  const user = process.env.SUPPORT_IMAP_USER;
  const pass = process.env.SUPPORT_IMAP_PASS;
  const folder = process.env.SUPPORT_IMAP_FOLDER || 'INBOX.Sent';

  if (!host || !user || !pass) {
    console.error('IMAP credentials missing!');
    return;
  }

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass }
  });

  try {
    console.log('IMAP: connecting...');
    await client.connect();

    console.log(`IMAP: opening folder ${folder}`);
    const mailbox = await client.mailboxOpen(folder);

    const total = mailbox.exists || 0;
    if (!total) {
      console.log('IMAP: folder is empty.');
      return;
    }

    // vezmeme posledných N správ (napr. 200)
    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;
    console.log(`IMAP: fetching messages range ${range} (total=${total}, limit=${limit})`);

    const messages = client.fetch(range, { source: true, envelope: true });

    for await (const msg of messages) {
      const parsed = await simpleParser(msg.source as any);

      const subject = parsed.subject || '';
      const from = parsed.from?.text || '';
      const to = parsed.to?.text || '';
      const bodyRaw = (parsed.text || parsed.html || '').toString();

      if (!bodyRaw.trim()) continue;

      // text, ktorý pôjde do embedu
      const textForEmbedding =
        `Subject: ${subject}\nFrom: ${from}\nTo: ${to}\n\n` +
        bodyRaw.slice(0, 5000); // limit, aby to nebolo nekonečné

      // vytvoríme embedding
      const embResp = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: textForEmbedding
      });

      const embedding = embResp.data[0].embedding;

      const doc = {
        id:
          (msg.uid && `imap-${msg.uid}`) ||
          `imap-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        text: textForEmbedding,
        embedding,
        meta: {
          sourceType: 'email',
          domain: 'tech',
          subject,
          from,
          to,
          date: parsed.date ? parsed.date.toISOString() : null
        }
      };

      appendToTechRag(doc);
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
