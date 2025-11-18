// email-import.ts
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';

const SUPPORT_IMAP_HOST = process.env.SUPPORT_IMAP_HOST || '';
const SUPPORT_IMAP_PORT = Number(process.env.SUPPORT_IMAP_PORT || '993');
const SUPPORT_IMAP_USER = process.env.SUPPORT_IMAP_USER || '';
const SUPPORT_IMAP_PASS = process.env.SUPPORT_IMAP_PASS || '';
const SUPPORT_IMAP_SECURE =
  (process.env.SUPPORT_IMAP_SECURE || 'true').toLowerCase() === 'true';

// Dôležité – priečinok, kde máš „Sent“ (podľa screenshotu: INBOX/Sent)
const SUPPORT_IMAP_FOLDER = process.env.SUPPORT_IMAP_FOLDER || 'INBOX/Sent';

// Kam budeme ukladať vyparsované konverzácie
const EMAIL_OUT_FILE = path.join(
  process.cwd(),
  'data',
  'support-emails.jsonl'
);

function ensureDataDir() {
  const dir = path.dirname(EMAIL_OUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Jednoduchý helper – zapíše 1 konverzáciu do JSONL.
 * Každý riadok = jeden dokument pre RAG (technická knowledge base).
 */
function appendEmailDoc(doc: any) {
  ensureDataDir();
  const line = JSON.stringify(doc) + '\n';
  fs.appendFileSync(EMAIL_OUT_FILE, line, 'utf8');
}

/**
 * Vytiahne posledných N mailov zo Sent a uloží ich ako textové dokumenty.
 * Zatiaľ bez deduplikácie – na prvé testy stačí.
 */
export async function importSupportEmailsOnce(limit = 50) {
  if (!SUPPORT_IMAP_HOST || !SUPPORT_IMAP_USER || !SUPPORT_IMAP_PASS) {
    console.error('IMAP env vars are not configured');
    throw new Error('IMAP config missing');
  }

  const client = new ImapFlow({
    host: SUPPORT_IMAP_HOST,
    port: SUPPORT_IMAP_PORT,
    secure: SUPPORT_IMAP_SECURE,
    auth: {
      user: SUPPORT_IMAP_USER,
      pass: SUPPORT_IMAP_PASS
    }
  });

  console.log('[email-import] Connecting to IMAP…');

  await client.connect();

  try {
    const lock = await client.getMailboxLock(SUPPORT_IMAP_FOLDER);
    try {
      console.log(
        `[email-import] Opened folder ${SUPPORT_IMAP_FOLDER}, total messages:`,
        client.mailbox.exists
      );

      // vezmeme posledných "limit" správ podľa UID
      const total = client.mailbox.exists || 0;
      if (!total) {
        console.log('[email-import] Folder is empty.');
        return { imported: 0 };
      }

      const fromUid = Math.max(1, total - limit + 1);
      const range = `${fromUid}:*`;

      let imported = 0;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        source: true
      })) {
        const parsed = await simpleParser(msg.source as Buffer);

        const subject = parsed.subject || '';
        const from = parsed.from?.text || '';
        const to = parsed.to?.text || '';
        const date = parsed.date?.toISOString?.() || '';
        const messageId = parsed.messageId || '';

        // text + html spojíme do jedného poľa
        const textParts = [];
        if (parsed.text) textParts.push(parsed.text);
        if (parsed.html) {
          // HTML trochu očistíme – odstránime tagy, aby to neplietlo model
          const withoutTags = parsed.html.replace(/<[^>]+>/g, ' ');
          textParts.push(withoutTags);
        }
        const bodyText = textParts.join('\n\n').replace(/\s+/g, ' ').trim();

        const doc = {
          text: `Predmet: ${subject}\nOd: ${from}\nKomu: ${to}\nDátum: ${date}\n\nObsah konverzácie:\n${bodyText}`,
          meta: {
            domain: 'tech',
            sourceType: 'email',
            subject,
            from,
            to,
            date,
            messageId,
            uid: msg.uid
          }
        };

        appendEmailDoc(doc);
        imported++;
      }

      console.log('[email-import] Import finished, docs:', imported);
      return { imported };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
