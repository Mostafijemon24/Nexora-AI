import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Mail } from './mail.ts';
import type { RateLimiter } from './ratelimit.ts';

/** The part of a mail transport the server uses to send from a workspace's own account. */
export interface SmtpTransport {
  sendMail(mail: { from: string | { name: string; address: string }; to: string; subject: string; text: string; inReplyTo?: string; references?: string }): Promise<{ messageId?: string }>;
  verify?(): Promise<unknown>;
}
export interface SmtpAccount { host: string; port: string; user: string; password: string }

/** One message read from a mailbox. */
export interface MailboxMessage { uid: number; from: string; name: string; subject: string; text: string; messageId: string; date: string }
export interface Mailbox {
  /**
   * Messages in the inbox with a uid above `uid` (a batch, oldest first), the uid reached and the
   * mailbox's validity stamp. With `null` it only reports where the mailbox ends now.
   */
  fetchAfter(uid: number | null): Promise<{ validity: string; lastUid: number; messages: MailboxMessage[] }>;
}
export interface ImapAccount { host: string; port: string; user: string; password: string }

/** Everything a request handler needs. Tests swap the clock, mail delivery and outbound fetch. */
export interface Ctx {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  /** Delivers or enqueues an email. */
  mail: (mail: Mail) => Promise<void>;
  now: () => Date;
  fetch: typeof fetch;
  /** Opens a workspace's own SMTP account for sending replies. */
  smtp: (account: SmtpAccount) => SmtpTransport;
  /** Reads a workspace's own mailbox over IMAP. */
  mailbox: (account: ImapAccount) => Mailbox;
  /** Resolves a host name to its addresses, to keep user-supplied addresses off private networks. Absent in tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "23 December 2026" (UTC) */
export const fullDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** "23 Nov 2026" (UTC) */
export const shortDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
