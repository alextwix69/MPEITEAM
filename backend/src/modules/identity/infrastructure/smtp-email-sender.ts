import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender, VerificationEmail } from '../application/email-sender.port';

export class SmtpEmailSender implements EmailSender {
  readonly #mailer: Transporter;

  constructor(
    smtpUrl: string,
    private readonly sender: string,
  ) {
    this.#mailer = nodemailer.createTransport(smtpUrl);
  }

  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    await this.#mailer.sendMail({
      from: this.sender,
      to: message.recipient,
      subject: 'Подтверждение электронной почты — Команда.МЭИ',
      text: `Подтвердите электронную почту: ${message.verificationUrl}`,
      messageId: `<${message.eventId}@komanda.mpei>`,
    });
  }

  close(): void {
    this.#mailer.close();
  }
}
