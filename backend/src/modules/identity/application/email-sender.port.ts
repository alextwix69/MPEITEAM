export interface VerificationEmail {
  eventId: string;
  recipient: string;
  verificationUrl: string;
}

export interface EmailSender {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(message: PasswordResetEmail): Promise<void>;
  close(): void;
}

export interface PasswordResetEmail {
  eventId: string;
  recipient: string;
  resetUrl: string;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
