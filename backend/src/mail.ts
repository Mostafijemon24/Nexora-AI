import nodemailer from 'nodemailer';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return { send: async (m) => { await transport.sendMail({ from, ...m }); } };
}

/** Development fallback when SMTP is not configured: the message goes to the server log. */
export const logMailer: Mailer = {
  async send(m) { console.warn(`[mail not sent — SMTP_URL is unset] to=${m.to} subject=${m.subject}\n${m.text}`); },
};

export function transferCodeMail(to: string, code: string, deviceName: string): Mail {
  return {
    to,
    subject: 'Your Nexora AI license transfer code',
    text: `Someone asked to move your Nexora AI license to "${deviceName}".\n\nTransfer code: ${code}\n\nIt expires in 10 minutes. `
      + 'Entering it deactivates the device the license is on now.\n\nIf this was not you, ignore this email — nothing changes without the code.',
  };
}
