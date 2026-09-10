import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseService } from '../../../platform/database/database.service';
import { ApplicationError } from '../../../platform/http/application-error';
import { getRequestContext } from '../../../platform/http/request-context';
import { runIdempotentCommand } from '../../../platform/idempotency/idempotent-command';
import type {
  FormalRole,
  ModerationPayload,
  ProfileDependencyChecks,
  ProfileInput,
  ProfileView,
  PublicProfileView,
  ResumeInput,
  ResumeView,
} from '../profiles.types';

export type InitialProfileInput = ProfileInput;

type ProfileVersionShape = {
  fullName: string;
  specialization: string;
  institute: string | null;
  course: number | null;
  department: string | null;
  company: string | null;
  position: string | null;
  avatarMediaId: string | null;
  state: 'draft' | 'pending' | 'approved' | 'rejected' | 'superseded';
  moderationDecisionId: string | null;
  moderationPolicyVersion: string | null;
  moderationViolationCodes: string[];
  moderationReason: string | null;
};
type ResumeVersionShape = {
  about: string;
  imageMediaId: string | null;
  projects: Array<{ title: string; description: string; url: string | null }>;
  tags: Array<{ tagId: string }>;
  state: 'draft' | 'pending' | 'approved' | 'rejected' | 'superseded';
  moderationDecisionId: string | null;
  moderationPolicyVersion: string | null;
  moderationViolationCodes: string[];
  moderationReason: string | null;
};

const moderationConsumer = 'trust.automated-moderation';
const notificationConsumer = 'notifications.moderation-result';

function profilePayload(value: ProfileVersionShape, timezone: string): ProfileInput {
  return {
    fullName: value.fullName,
    specialization: value.specialization,
    timezone,
    ...(value.institute ? { institute: value.institute } : {}),
    ...(value.course !== null ? { course: value.course } : {}),
    ...(value.department ? { department: value.department } : {}),
    ...(value.company ? { company: value.company } : {}),
    ...(value.position ? { position: value.position } : {}),
    ...(value.avatarMediaId ? { avatarMediaId: value.avatarMediaId } : {}),
  };
}

function resumePayload(value: ResumeVersionShape, searchVisible: boolean): ResumeInput {
  return {
    about: value.about,
    projects: value.projects.map((project) => ({
      title: project.title,
      description: project.description,
      ...(project.url ? { url: project.url } : {}),
    })),
    tagIds: value.tags.map(({ tagId }) => tagId),
    searchVisible,
    ...(value.imageMediaId ? { imageMediaId: value.imageMediaId } : {}),
  };
}

function assertRoleFields(role: FormalRole, input: ProfileInput): void {
  const invalid =
    (role === 'student' &&
      (!input.institute ||
        input.course === undefined ||
        input.department !== undefined ||
        input.company !== undefined ||
        input.position !== undefined)) ||
    (role === 'teacher' &&
      (!input.department ||
        input.institute !== undefined ||
        input.course !== undefined ||
        input.company !== undefined)) ||
    (role === 'employer' &&
      (!input.company ||
        input.institute !== undefined ||
        input.course !== undefined ||
        input.department !== undefined));
  if (invalid) {
    throw new ApplicationError(
      'ROLE_FIELDS_INVALID',
      'Заполните только поля, соответствующие вашей роли.',
      422,
    );
  }
}

@Injectable()
export class ProfilesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async ownsMediaOwner(
    accountId: string,
    ownerType: 'profile' | 'resume',
    ownerId: string,
  ): Promise<boolean> {
    return ownerType === 'profile'
      ? Boolean(
          await this.database.profile.findFirst({
            where: { id: ownerId, accountId },
            select: { id: true },
          }),
        )
      : Boolean(
          await this.database.resume.findFirst({
            where: { id: ownerId, profile: { accountId } },
            select: { id: true },
          }),
        );
  }

  async isPublishedMedia(mediaId: string): Promise<boolean> {
    const profileVersions = await this.database.profileVersion.findMany({
      where: { avatarMediaId: mediaId, state: 'approved' },
      select: { id: true },
    });
    if (
      profileVersions.length > 0 &&
      (await this.database.profile.findFirst({
        where: { publishedVersionId: { in: profileVersions.map(({ id }) => id) } },
        select: { id: true },
      }))
    ) {
      return true;
    }
    const resumeVersions = await this.database.resumeVersion.findMany({
      where: { imageMediaId: mediaId, state: 'approved' },
      select: { id: true },
    });
    return Boolean(
      resumeVersions.length > 0 &&
      (await this.database.resume.findFirst({
        where: { publishedVersionId: { in: resumeVersions.map(({ id }) => id) } },
        select: { id: true },
      })),
    );
  }

  async createInitialProfile(
    transaction: Prisma.TransactionClient,
    accountId: string,
    formalRole: FormalRole,
    input: InitialProfileInput,
  ): Promise<{ profileId: string; resumeId: string }> {
    const profileId = uuidv7();
    const resumeId = uuidv7();
    const profileVersionId = uuidv7();
    await transaction.profile.create({
      data: { id: profileId, accountId, formalRole, timezone: input.timezone },
    });
    await transaction.profileVersion.create({
      data: {
        id: profileVersionId,
        profileId,
        versionNo: 1,
        fullName: input.fullName,
        specialization: input.specialization,
        institute: input.institute,
        course: input.course,
        department: input.department,
        company: input.company,
        position: input.position,
        avatarMediaId: input.avatarMediaId,
      },
    });
    await transaction.profile.update({
      where: { id: profileId },
      data: { pendingVersionId: profileVersionId },
    });
    await transaction.resume.create({
      data: { id: resumeId, profileId, slot: 0, isSearchVisible: true },
    });
    return { profileId, resumeId };
  }

  async getOwnProfile(accountId: string): Promise<ProfileView> {
    const root = await this.database.profile.findUnique({ where: { accountId } });
    if (!root) this.notFound();
    const [published, pending] = await Promise.all([
      root.publishedVersionId
        ? this.database.profileVersion.findUnique({ where: { id: root.publishedVersionId } })
        : undefined,
      root.pendingVersionId
        ? this.database.profileVersion.findUnique({ where: { id: root.pendingVersionId } })
        : undefined,
    ]);
    return {
      id: root.id,
      accountId,
      formalRole: root.formalRole,
      publicationState: root.publicationState,
      ...(published ? { published: profilePayload(published, root.timezone) } : {}),
      ...(pending ? { pending: profilePayload(pending, root.timezone) } : {}),
      editLocked: root.editLocked,
      moderation: this.moderationView(root.publicationState, pending ?? published),
      rowVersion: Number(root.rowVersion),
      createdAt: root.createdAt.toISOString(),
      updatedAt: root.updatedAt.toISOString(),
    };
  }

  async listOwnResumes(accountId: string): Promise<ResumeView[]> {
    const roots = await this.database.resume.findMany({
      where: { profile: { accountId } },
      orderBy: { slot: 'asc' },
    });
    return Promise.all(roots.map((root) => this.toResumeView(root)));
  }

  async getOwnResume(accountId: string, resumeId: string): Promise<ResumeView> {
    const root = await this.database.resume.findFirst({
      where: { id: resumeId, profile: { accountId } },
    });
    if (!root) this.notFound();
    return this.toResumeView(root);
  }

  async getPublicProfile(accountId: string): Promise<PublicProfileView> {
    const root = await this.database.profile.findFirst({
      where: { accountId, publishedVersionId: { not: null } },
    });
    if (!root?.publishedVersionId) this.notFound();
    const published = await this.database.profileVersion.findUnique({
      where: { id: root.publishedVersionId },
    });
    if (!published || published.state !== 'approved') this.notFound();
    const roots = await this.database.resume.findMany({
      where: { profileId: root.id, isSearchVisible: true, publishedVersionId: { not: null } },
      orderBy: { slot: 'asc' },
    });
    const resumes: PublicProfileView['resumes'] = [];
    for (const resume of roots) {
      if (!resume.publishedVersionId) continue;
      const version = await this.loadResumeVersion(resume.publishedVersionId);
      if (!version) continue;
      const data = resumePayload(version, true);
      resumes.push({
        id: resume.id,
        slot: resume.slot,
        about: data.about,
        projects: data.projects,
        tagIds: data.tagIds,
        ...(data.imageMediaId ? { imageMediaId: data.imageMediaId } : {}),
      });
    }
    return {
      accountId,
      formalRole: root.formalRole,
      profile: profilePayload(published, root.timezone),
      resumes,
    };
  }

  async updateOwnProfile(
    accountId: string,
    input: ProfileInput,
    expectedVersion: number,
    idempotencyKey: string,
    dependencies: ProfileDependencyChecks,
  ) {
    return runIdempotentCommand(
      this.database,
      accountId,
      'PATCH /me/profile',
      idempotencyKey,
      input,
      async (transaction) => {
        const root = await transaction.profile.findUnique({ where: { accountId } });
        if (!root) this.notFound();
        assertRoleFields(root.formalRole, input);
        if (root.editLocked || root.publicationState === 'pending') this.locked();
        const claimed = await transaction.profile.updateMany({
          where: {
            id: root.id,
            rowVersion: BigInt(expectedVersion),
            publicationState: { not: 'pending' },
          },
          data: {
            timezone: input.timezone,
            publicationState: 'pending',
            rowVersion: { increment: 1 },
          },
        });
        if (claimed.count !== 1) this.mismatch(Number(root.rowVersion));
        const max = await transaction.profileVersion.aggregate({
          where: { profileId: root.id },
          _max: { versionNo: true },
        });
        const versionId = uuidv7();
        await transaction.profileVersion.create({
          data: {
            id: versionId,
            profileId: root.id,
            versionNo: (max._max.versionNo ?? 0) + 1,
            state: 'pending',
            fullName: input.fullName,
            specialization: input.specialization,
            institute: input.institute,
            course: input.course,
            department: input.department,
            company: input.company,
            position: input.position,
            avatarMediaId: input.avatarMediaId,
            submittedAt: new Date(),
          },
        });
        if (input.avatarMediaId)
          await dependencies.validateAndBindMedia(transaction, {
            accountId,
            mediaId: input.avatarMediaId,
            ownerType: 'profile',
            ownerId: root.id,
            versionType: 'profile_version',
            versionId,
          });
        await transaction.profile.update({
          where: { id: root.id },
          data: { pendingVersionId: versionId },
        });
        await this.enqueueModeration(transaction, accountId, 'profile_version', versionId, root.id);
        return {
          body: await this.profileViewInTransaction(transaction, root.id),
          responseRefType: 'profile',
          responseRefId: root.id,
          status: 202,
        };
      },
    );
  }

  async updateOwnResume(
    accountId: string,
    resumeId: string,
    input: ResumeInput,
    expectedVersion: number,
    idempotencyKey: string,
    dependencies: ProfileDependencyChecks,
  ) {
    if (!input.searchVisible)
      throw new ApplicationError(
        'PRIMARY_RESUME_MUST_BE_VISIBLE',
        'Основное резюме всегда видно в поиске.',
        422,
      );
    return runIdempotentCommand(
      this.database,
      accountId,
      'PATCH /me/resumes/{resumeId}',
      idempotencyKey,
      { resumeId, ...input },
      async (transaction) => {
        const root = await transaction.resume.findFirst({
          where: { id: resumeId, slot: 0, profile: { accountId } },
        });
        if (!root) this.notFound();
        if (root.editLocked || root.publicationState === 'pending') this.locked();
        const claimed = await transaction.resume.updateMany({
          where: {
            id: root.id,
            rowVersion: BigInt(expectedVersion),
            publicationState: { not: 'pending' },
          },
          data: { publicationState: 'pending', rowVersion: { increment: 1 } },
        });
        if (claimed.count !== 1) this.mismatch(Number(root.rowVersion));
        await dependencies.validateTags(transaction, input.tagIds);
        const max = await transaction.resumeVersion.aggregate({
          where: { resumeId },
          _max: { versionNo: true },
        });
        const versionId = uuidv7();
        await transaction.resumeVersion.create({
          data: {
            id: versionId,
            resumeId,
            versionNo: (max._max.versionNo ?? 0) + 1,
            state: 'pending',
            about: input.about,
            imageMediaId: input.imageMediaId,
            submittedAt: new Date(),
            projects: {
              create: input.projects.map((project, index) => ({ position: index + 1, ...project })),
            },
            tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
          },
        });
        if (input.imageMediaId)
          await dependencies.validateAndBindMedia(transaction, {
            accountId,
            mediaId: input.imageMediaId,
            ownerType: 'resume',
            ownerId: resumeId,
            versionType: 'resume_version',
            versionId,
          });
        await transaction.resume.update({
          where: { id: resumeId },
          data: { pendingVersionId: versionId },
        });
        await this.enqueueModeration(transaction, accountId, 'resume_version', versionId, resumeId);
        return {
          body: await this.resumeViewInTransaction(transaction, resumeId),
          responseRefType: 'resume',
          responseRefId: resumeId,
          status: 202,
        };
      },
    );
  }

  async moderationPayload(
    contentType: 'profile_version' | 'resume_version',
    versionId: string,
  ): Promise<ModerationPayload | undefined> {
    if (contentType === 'profile_version') {
      const version = await this.database.profileVersion.findUnique({
        where: { id: versionId },
        include: { profile: true },
      });
      if (!version) return undefined;
      return {
        contentType,
        contentId: version.profileId,
        contentVersionId: versionId,
        ownerAccountId: version.profile.accountId,
        text: [
          version.fullName,
          version.specialization,
          version.institute,
          version.department,
          version.company,
          version.position,
        ]
          .filter(Boolean)
          .join('\n'),
        ...(version.avatarMediaId ? { mediaId: version.avatarMediaId } : {}),
      };
    }
    const version = await this.database.resumeVersion.findUnique({
      where: { id: versionId },
      include: {
        resume: { include: { profile: true } },
        projects: { orderBy: { position: 'asc' } },
      },
    });
    if (!version) return undefined;
    return {
      contentType,
      contentId: version.resumeId,
      contentVersionId: versionId,
      ownerAccountId: version.resume.profile.accountId,
      text: [
        version.about,
        ...version.projects.flatMap((project) => [project.title, project.description]),
      ]
        .filter(Boolean)
        .join('\n'),
      ...(version.imageMediaId ? { mediaId: version.imageMediaId } : {}),
    };
  }

  async applyModerationDecision(
    transaction: Prisma.TransactionClient,
    input: {
      sourceEventId: string;
      decisionId: string;
      contentType: 'profile_version' | 'resume_version';
      contentId: string;
      contentVersionId: string;
      ownerAccountId: string;
      approved: boolean;
      policyVersion: string;
      violationCodes: string[];
      reason?: string;
    },
  ): Promise<boolean> {
    const inserted = await transaction.$executeRaw`
      INSERT INTO profiles.inbox_events (event_id, consumer, event_version, processed_at, result_ref_id)
      VALUES (${input.sourceEventId}::uuid, 'profiles.moderation-result', 1, now(), ${input.decisionId}::uuid)
      ON CONFLICT (event_id) DO NOTHING
    `;
    if (inserted !== 1) return false;
    const now = new Date();
    if (input.contentType === 'profile_version') {
      const root = await transaction.profile.findUnique({ where: { id: input.contentId } });
      if (!root || root.pendingVersionId !== input.contentVersionId) return false;
      await transaction.profileVersion.update({
        where: { id: input.contentVersionId },
        data: {
          state: input.approved ? 'approved' : 'rejected',
          decidedAt: now,
          moderationDecisionId: input.decisionId,
          moderationPolicyVersion: input.policyVersion,
          moderationViolationCodes: input.violationCodes,
          moderationReason: input.reason,
        },
      });
      await transaction.profile.update({
        where: { id: input.contentId },
        data: {
          ...(input.approved
            ? { pendingVersionId: null, publishedVersionId: input.contentVersionId }
            : {}),
          publicationState: input.approved ? 'published' : 'revision_required',
          rowVersion: { increment: 1 },
        },
      });
    } else {
      const root = await transaction.resume.findUnique({ where: { id: input.contentId } });
      if (!root || root.pendingVersionId !== input.contentVersionId) return false;
      await transaction.resumeVersion.update({
        where: { id: input.contentVersionId },
        data: {
          state: input.approved ? 'approved' : 'rejected',
          decidedAt: now,
          moderationDecisionId: input.decisionId,
          moderationPolicyVersion: input.policyVersion,
          moderationViolationCodes: input.violationCodes,
          moderationReason: input.reason,
        },
      });
      await transaction.resume.update({
        where: { id: input.contentId },
        data: {
          ...(input.approved
            ? { pendingVersionId: null, publishedVersionId: input.contentVersionId }
            : {}),
          publicationState: input.approved ? 'published' : 'revision_required',
          rowVersion: { increment: 1 },
        },
      });
    }
    const eventId = uuidv7();
    await transaction.outboxEvent.create({
      data: {
        id: eventId,
        eventType: 'profiles.moderation.decided',
        eventVersion: 1,
        aggregateType: input.contentType === 'profile_version' ? 'profile' : 'resume',
        aggregateId: input.contentId,
        occurredAt: now,
        correlationId: getRequestContext()?.correlationId ?? input.sourceEventId,
        actorAccountId: input.ownerAccountId,
        payload: {
          recipientAccountId: input.ownerAccountId,
          decisionId: input.decisionId,
          contentType: input.contentType === 'profile_version' ? 'profile' : 'resume',
          contentId: input.contentId,
          approved: input.approved,
          policyVersion: input.policyVersion,
          violationCodes: input.violationCodes,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        deliveries: { create: { id: uuidv7(), consumer: notificationConsumer, availableAt: now } },
      },
    });
    return true;
  }

  private async enqueueModeration(
    transaction: Prisma.TransactionClient,
    accountId: string,
    contentType: 'profile_version' | 'resume_version',
    versionId: string,
    rootId: string,
  ): Promise<void> {
    const eventId = uuidv7();
    const now = new Date();
    await transaction.outboxEvent.create({
      data: {
        id: eventId,
        eventType: 'profiles.moderation.requested',
        eventVersion: 1,
        aggregateType: contentType === 'profile_version' ? 'profile' : 'resume',
        aggregateId: rootId,
        occurredAt: now,
        correlationId: getRequestContext()?.correlationId ?? eventId,
        actorAccountId: accountId,
        payload: { contentType, contentVersionId: versionId, ownerAccountId: accountId },
        deliveries: { create: { id: uuidv7(), consumer: moderationConsumer, availableAt: now } },
      },
    });
  }

  private async toResumeView(root: {
    id: string;
    slot: number;
    isSearchVisible: boolean;
    publicationState: ProfileView['publicationState'];
    publishedVersionId: string | null;
    pendingVersionId: string | null;
    editLocked: boolean;
    rowVersion: bigint;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<ResumeView> {
    const [published, pending] = await Promise.all([
      root.publishedVersionId ? this.loadResumeVersion(root.publishedVersionId) : undefined,
      root.pendingVersionId ? this.loadResumeVersion(root.pendingVersionId) : undefined,
    ]);
    return {
      id: root.id,
      slot: root.slot,
      primary: root.slot === 0,
      searchVisible: root.isSearchVisible,
      publicationState: root.publicationState,
      ...(published ? { published: resumePayload(published, root.isSearchVisible) } : {}),
      ...(pending ? { pending: resumePayload(pending, root.isSearchVisible) } : {}),
      editLocked: root.editLocked,
      moderation: this.moderationView(root.publicationState, pending ?? published),
      rowVersion: Number(root.rowVersion),
      createdAt: root.createdAt.toISOString(),
      updatedAt: root.updatedAt.toISOString(),
    };
  }

  private async profileViewInTransaction(
    transaction: Prisma.TransactionClient,
    profileId: string,
  ): Promise<ProfileView> {
    const root = await transaction.profile.findUniqueOrThrow({ where: { id: profileId } });
    const [published, pending] = await Promise.all([
      root.publishedVersionId
        ? transaction.profileVersion.findUnique({ where: { id: root.publishedVersionId } })
        : undefined,
      root.pendingVersionId
        ? transaction.profileVersion.findUnique({ where: { id: root.pendingVersionId } })
        : undefined,
    ]);
    return {
      id: root.id,
      accountId: root.accountId,
      formalRole: root.formalRole,
      publicationState: root.publicationState,
      ...(published ? { published: profilePayload(published, root.timezone) } : {}),
      ...(pending ? { pending: profilePayload(pending, root.timezone) } : {}),
      editLocked: root.editLocked,
      moderation: this.moderationView(root.publicationState, pending ?? published),
      rowVersion: Number(root.rowVersion),
      createdAt: root.createdAt.toISOString(),
      updatedAt: root.updatedAt.toISOString(),
    };
  }

  private async resumeViewInTransaction(
    transaction: Prisma.TransactionClient,
    resumeId: string,
  ): Promise<ResumeView> {
    const root = await transaction.resume.findUniqueOrThrow({ where: { id: resumeId } });
    const [published, pending] = await Promise.all([
      root.publishedVersionId
        ? transaction.resumeVersion.findUnique({
            where: { id: root.publishedVersionId },
            include: { projects: { orderBy: { position: 'asc' } }, tags: true },
          })
        : undefined,
      root.pendingVersionId
        ? transaction.resumeVersion.findUnique({
            where: { id: root.pendingVersionId },
            include: { projects: { orderBy: { position: 'asc' } }, tags: true },
          })
        : undefined,
    ]);
    return {
      id: root.id,
      slot: root.slot,
      primary: root.slot === 0,
      searchVisible: root.isSearchVisible,
      publicationState: root.publicationState,
      ...(published ? { published: resumePayload(published, root.isSearchVisible) } : {}),
      ...(pending ? { pending: resumePayload(pending, root.isSearchVisible) } : {}),
      editLocked: root.editLocked,
      moderation: this.moderationView(root.publicationState, pending ?? published),
      rowVersion: Number(root.rowVersion),
      createdAt: root.createdAt.toISOString(),
      updatedAt: root.updatedAt.toISOString(),
    };
  }

  private loadResumeVersion(id: string): Promise<ResumeVersionShape | null> {
    return this.database.resumeVersion.findUnique({
      where: { id },
      include: { projects: { orderBy: { position: 'asc' } }, tags: true },
    });
  }

  private moderationState(state: ProfileView['publicationState']) {
    if (state === 'pending') return 'pending' as const;
    if (state === 'published') return 'approved' as const;
    if (state === 'revision_required') return 'revision_required' as const;
    return 'not_submitted' as const;
  }

  private moderationView(
    state: ProfileView['publicationState'],
    version?: ProfileVersionShape | ResumeVersionShape | null,
  ) {
    return {
      state: this.moderationState(state),
      ...(version?.moderationDecisionId ? { decisionId: version.moderationDecisionId } : {}),
      ...(version?.moderationViolationCodes.length
        ? { violationCodes: version.moderationViolationCodes }
        : {}),
      ...(version?.moderationReason ? { reason: version.moderationReason } : {}),
    };
  }

  private mismatch(currentVersion: number): never {
    throw new ApplicationError(
      'VERSION_MISMATCH',
      'Данные уже изменились. Обновите страницу и повторите попытку.',
      412,
      false,
      { currentVersion },
    );
  }
  private locked(): never {
    throw new ApplicationError(
      'CONTENT_EDIT_LOCKED',
      'Текущая версия уже проверяется. Дождитесь результата.',
      409,
    );
  }
  private notFound(): never {
    throw new ApplicationError('RESOURCE_NOT_FOUND', 'Запрошенный профиль не найден.', 404);
  }
}
