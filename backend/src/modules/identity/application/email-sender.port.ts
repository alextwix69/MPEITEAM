export interface VerificationEmail {
  eventId: string;
  recipient: string;
  verificationUrl: string;
}

export interface EmailSender {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(message: PasswordResetEmail): Promise<void>;
  sendModerationResultEmail?(message: ModerationResultEmail): Promise<void>;
  close(): void;
}

export interface ModerationResultEmail {
  eventId: string;
  recipient: string;
  approved: boolean;
  contentType: 'profile' | 'resume';
  contentUrl: string;
  violationCodes: string[];
  reason?: string;
}

export interface PasswordResetEmail {
  eventId: string;
  recipient: string;
  resetUrl: string;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
