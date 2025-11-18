import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';

const TECH_RAG_FILE = path.join(process.cwd(), 'data', 'rag-tech.jsonl');

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
    console.error("IMAP credentials missing!");
    return;
  }

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass }
  });

  try {
    console.log("Connecting to IMAP...");
    await client.connect();

    console.log(`Opening folder: ${folder}`);
    await client.mailboxOpen(folder);

    const messages = client.fetch({ limit: 200, reverse: true }, { source: true });

    for await (const msg of messages) {
      const parsed = await simpleParser(msg.source);

      const subject = parsed.subject || '';
      const body = parsed.text || parsed.html || '';

      // uložíme iba ak je to technická odpoveď
      if (!body) continue;

      appendToTechRag({
        ts: new Date().toISOString(),
        type: "tech-email",
        subject,
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        text: body.substring(0, 5000),   // limit pre embedding
        domain: "tech",
        sourceType: "email"
      });
    }

    console.log("IMAP import completed.");
  } catch (err) {
    console.error("IMAP import error:", err);
  } finally {
    await client.logout();
  }
}
