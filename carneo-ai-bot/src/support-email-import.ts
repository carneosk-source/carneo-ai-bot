// support-email-import.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const EMAIL_KB_FILE = path.join(process.cwd(), 'data', 'tech-emails.jsonl');

function ensureDirFor(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadExistingIds(): Set<string> {
  if (!fs.existsSync(EMAIL_KB_FILE)) return new Set();
  const raw = fs.readFileSync(EMAIL_KB_FILE, 'utf-8');
  const ids = new Set<string>();

  raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.id) ids.add(String(obj.id));
      } catch {
        // ignoruj pokazené riadky
      }
    });

  return ids;
}

// hrubé očistenie citovaných mailov / podpisov
function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.split('\n');

  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // primitívne heuristiky – môžeme časom zlepšiť
    if (trimmed.startsWith('>')) continue; // citovaný text
    if (/^On .+wrote:$/i.test(trimmed)) continue; // "On Mon, ... wrote:"
    if (/^Dňa .+napísal/i.test(trimmed)) continue;
    if (/^From: /i.test(trimmed)) continue;

    out.push(line);
  }

  return out.join('\n').trim();
}

export async function importSupportEmails(options?: { days?: number }) {
  const {
    SUPPORT_IMAP_HOST,
    SUPPORT_IMAP_PORT,
    SUPPORT_IMAP_SECURE,
    SUPPORT_IMAP_USER,
    SUPPORT_IMAP_PASS,
    SUPPORT_IMAP_FOLDER
  } = process.env;

  if (
    !SUPPORT_IMAP_HOST ||
    !SUPPORT_IMAP_USER ||
    !SUPPORT_IMAP_PASS ||
    !SUPPORT_IMAP_FOLDER
  ) {
    throw new Error('IMAP env vars are missing (SUPPORT_IMAP_*)');
  }

  const days = options?.days ?? 1;
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host: SUPPORT_IMAP_HOST,
    port: Number(SUPPORT_IMAP_PORT || 993),
    secure: SUPPORT_IMAP_SECURE !== 'false',
    auth: {
      user: SUPPORT_IMAP_USER,
      pass: SUPPORT_IMAP_PASS
    }
  });

  await client.connect();
  await client.mailboxOpen(SUPPORT_IMAP_FOLDER);

  // zoznam ID, ktoré už máme, aby sme neimportovali duplicitne
  ensureDirFor(EMAIL_KB_FILE);
  const existingIds = loadExistingIds();

  // nájdeme správy od "sinceDate"
  const searchCriteria: any[] = ['SINCE', sinceDate];
  const uids = await client.search(searchCriteria);

  let imported = 0;
  let skippedExisting = 0;

  const appendStream = fs.createWriteStream(EMAIL_KB_FILE, {
    flags: 'a'
  });

  try {
    for await (const msg of client.fetch(uids, {
      source: true,
      envelope: true,
      internalDate: true
    })) {
      const parsed = await simpleParser(msg.source as Buffer);

      const messageId = parsed.messageId || crypto.randomUUID();
      const id = 'email-' + crypto.createHash('sha1').update(messageId).digest('hex');

      if (existingIds.has(id)) {
        skippedExisting++;
        continue;
      }

      const subject = parsed.subject || '';
      const from = parsed.from?.text || '';
      const to = parsed.to?.text || '';
      const date = parsed.date || msg.internalDate || new Date();

      const plain = cleanText(parsed.text || '');
      const html = parsed.html ? String(parsed.html) : '';

      // veľmi jednoduchý odhad produktu z predmetu / textu
      const productGuess = ''; // TODO: prípadne doplniť podľa kľúčových slov

      const record = {
        id,
        domain: 'tech', // dôležité pre search({ domain: 'tech' })
        sourceType: 'email',
        subject,
        from,
        to,
        date: date.toISOString(),
        productGuess,
        text: plain,
        htmlSnippet: html ? html.slice(0, 2000) : null,
        tags: ['support-email', 'tech'],
        // pole "raw" NEukladám – JSONL by bol zbytočne obrovský
      };

      appendStream.write(JSON.stringify(record) + '\n');
      imported++;
    }
  } finally {
    appendStream.end();
    await client.logout();
  }

  return {
    imported,
    skippedExisting,
    folder: SUPPORT_IMAP_FOLDER,
    since: sinceDate.toISOString()
  };
}
