import type { Prisma } from '@prisma/client';

export type FormalRole = 'student' | 'teacher' | 'employer';

export interface ProfileInput {
  fullName: string;
  specialization: string;
  timezone: string;
  institute?: string;
  course?: number;
  department?: string;
  company?: string;
  position?: string;
  avatarMediaId?: string;
}

export interface ResumeProjectInput {
  title: string;
  description: string;
  url?: string;
}

export interface ResumeInput {
  about: string;
  projects: ResumeProjectInput[];
  tagIds: string[];
  searchVisible: boolean;
  imageMediaId?: string;
}

export interface ModerationStatusView {
  state:
    | 'not_submitted'
    | 'pending'
    | 'approved'
    | 'revision_required'
    | 'failed'
    | 'manual_review_pending'
    | 'appeal_pending';
  decisionId?: string;
  violationCodes?: string[];
  reason?: string;
}

export interface ProfileView {
  id: string;
  accountId: string;
  formalRole: FormalRole;
  publicationState: 'draft' | 'pending' | 'published' | 'revision_required' | 'hidden' | 'deleting';
  published?: ProfileInput;
  pending?: ProfileInput;
  editLocked: boolean;
  moderation?: ModerationStatusView;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeView {
  id: string;
  slot: number;
  primary: boolean;
  searchVisible: boolean;
  publicationState: 'draft' | 'pending' | 'published' | 'revision_required' | 'hidden' | 'deleting';
  published?: ResumeInput;
  pending?: ResumeInput;
  editLocked: boolean;
  moderation?: ModerationStatusView;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicProfileView {
  accountId: string;
  formalRole: FormalRole;
  profile: ProfileInput;
  resumes: Array<{
    id: string;
    slot: number;
    about: string;
    projects: ResumeProjectInput[];
    tagIds: string[];
    imageMediaId?: string;
  }>;
}

export interface ProfileDependencyChecks {
  validateAndBindMedia(
    transaction: Prisma.TransactionClient,
    input: {
      accountId: string;
      mediaId: string;
      ownerType: 'profile' | 'resume';
      ownerId: string;
      versionType: 'profile_version' | 'resume_version';
      versionId: string;
    },
  ): Promise<void>;
  validateTags(transaction: Prisma.TransactionClient, tagIds: string[]): Promise<void>;
}

export interface ModerationPayload {
  contentType: 'profile_version' | 'resume_version';
  contentId: string;
  contentVersionId: string;
  ownerAccountId: string;
  text: string;
  mediaId?: string;
}
