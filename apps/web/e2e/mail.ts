import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const OUTBOX = path.resolve(import.meta.dirname, '..', '.mail-outbox');

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Waits for the newest email to `to` whose subject matches, and returns its first link. */
export async function latestLink(to: string, subject: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = (await readdir(OUTBOX).catch(() => [])).sort().reverse();
    for (const file of files) {
      const mail = JSON.parse(await readFile(path.join(OUTBOX, file), 'utf8')) as Mail;
      if (mail.to === to && subject.test(mail.subject)) {
        const link = mail.text.match(/https?:\/\/\S+/)?.[0];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email to ${to} matching ${subject}`);
}
