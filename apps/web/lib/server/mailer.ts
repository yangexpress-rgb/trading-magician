import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTransport } from 'nodemailer';
import { serverEnv } from './env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }
  async send(message: MailMessage) {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/** Writes each message to a JSON file. Development and end-to-end tests only. */
class OutboxMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(message: MailMessage) {
    await mkdir(this.dir, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await writeFile(path.join(this.dir, name), JSON.stringify(message));
  }
}

let mailer: Mailer | undefined;
export function getMailer(): Mailer {
  if (mailer) return mailer;
  const env = serverEnv();
  mailer =
    env.MAIL_TRANSPORT === 'outbox'
      ? new OutboxMailer(path.resolve(env.MAIL_OUTBOX_DIR))
      : new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return mailer;
}
