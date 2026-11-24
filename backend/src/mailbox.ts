// Reads new mail from a workspace's own mailbox over IMAP. Read-only: nothing is deleted, moved
// or marked as read.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ImapAccount, Mailbox, MailboxMessage } from './context.ts';

/** The most messages taken in one pass, so a busy mailbox cannot stall the worker. */
const BATCH = 50;
/** Messages larger than this are skipped. */
const MAX_BYTES = 2 * 1024 * 1024;

/** The reply a person wrote, without the quoted earlier message underneath it. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^On .{0,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^_{10,}$/.test(l.trim()));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith('>'));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function imapMailbox(account: ImapAccount): Mailbox {
  return {
    async fetchAfter(uid) {
      const client = new ImapFlow({
        host: account.host, port: Number(account.port) || 993, secure: (Number(account.port) || 993) === 993,
        auth: { user: account.user, pass: account.password }, logger: false,
      });
      await client.connect();
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const box = client.mailbox;
          if (!box) throw new Error('The inbox could not be opened.');
          const validity = String(box.uidValidity);
          const top = box.uidNext - 1;
          if (uid === null) return { validity, lastUid: top, messages: [] };
          if (top <= uid) return { validity, lastUid: uid, messages: [] };
          const end = Math.min(top, uid + BATCH);
          const messages: MailboxMessage[] = [];
          for await (const m of client.fetch(`${uid + 1}:${end}`, { uid: true, envelope: true, source: { maxLength: MAX_BYTES } }, { uid: true })) {
            if (m.uid <= uid || !m.source) continue;
            const from = m.envelope?.from?.[0];
            if (!from?.address) continue;
            const parsed = await simpleParser(m.source);
            messages.push({
              uid: m.uid, from: from.address, name: from.name ?? '', subject: m.envelope?.subject ?? '',
              text: stripQuoted(parsed.text ?? ''), messageId: m.envelope?.messageId ?? '',
              date: new Date(m.envelope?.date ?? Date.now()).toISOString(),
            });
          }
          return { validity, lastUid: end, messages };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}
