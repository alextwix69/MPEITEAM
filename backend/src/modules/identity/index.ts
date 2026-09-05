export { IdentityModule } from './identity.module';
export { IdentityService } from './application/identity.service';
export { EMAIL_SENDER } from './application/email-sender.port';
export type { EmailSender, VerificationEmail } from './application/email-sender.port';
export { SmtpEmailSender } from './infrastructure/smtp-email-sender';
export { deliverPasswordReset } from './infrastructure/password-reset-delivery';
export type { PasswordResetEmail } from './application/email-sender.port';
export type { CurrentAccount, RegistrationResult, SessionView } from './identity.types';
