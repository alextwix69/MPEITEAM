export const consentDocumentTypes = [
  'age_18',
  'user_terms',
  'personal_data',
  'public_profile_distribution',
] as const;

export type ConsentDocumentType = (typeof consentDocumentTypes)[number];

export interface RegistrationResult {
  accountId: string;
  accountState: 'unverified';
  verificationEmailQueued: boolean;
}

export interface SessionView {
  accountId: string;
  accountState: 'active' | 'unverified' | 'deleting' | 'deleted';
  expiresAt: string;
}

export interface CurrentAccount {
  id: string;
  formalRole: 'student' | 'teacher' | 'employer';
  systemRole: 'user' | 'moderator';
  state: 'active' | 'unverified' | 'deleting' | 'deleted';
  emailVerified: boolean;
  capabilities: string[];
  deletionIrreversibleAt?: string;
  createdAt: string;
}

export interface CommandResult<T> {
  body: T;
  replayed: boolean;
  sessionSecret?: string;
}
