import nodemailer, { type Transporter } from 'nodemailer';
import type {
  EmailSender,
  VerificationEmail,
  PasswordResetEmail,
  ModerationResultEmail,
} from '../application/email-sender.port';

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

  async sendPasswordResetEmail(message: PasswordResetEmail): Promise<void> {
    await this.#mailer.sendMail({
      from: this.sender,
      to: message.recipient,
      subject: 'Восстановление доступа — Команда.МЭИ',
      text: `Установите новый пароль: ${message.resetUrl}\nЕсли вы не запрашивали восстановление, проигнорируйте письмо.`,
      messageId: `<${message.eventId}@komanda.mpei>`,
    });
  }

  async sendModerationResultEmail(message: ModerationResultEmail): Promise<void> {
    const subject = message.approved
      ? 'Материал одобрен — Команда.МЭИ'
      : 'Материал нужно доработать — Команда.МЭИ';
    const details = message.approved
      ? 'Проверка завершена: материал опубликован.'
      : `Проверка завершена: исправьте материал и отправьте его повторно.\nКоды: ${message.violationCodes.join(', ')}${message.reason ? `\n${message.reason}` : ''}`;
    await this.#mailer.sendMail({
      from: this.sender,
      to: message.recipient,
      subject,
      text: `${details}\n${message.contentUrl}`,
      messageId: `<${message.eventId}@komanda.mpei>`,
    });
  }
}
