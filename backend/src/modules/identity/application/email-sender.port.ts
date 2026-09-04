export interface VerificationEmail {
  eventId: string;
  recipient: string;
  verificationUrl: string;
}

export interface EmailSender {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
  close(): void;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
