import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseService } from '../../../platform/database/database.service';

export type FormalRole = 'student' | 'teacher' | 'employer';

export interface InitialProfileInput {
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

@Injectable()
export class ProfilesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async ownsMediaOwner(
    accountId: string,
    ownerType: 'profile' | 'resume',
    ownerId: string,
  ): Promise<boolean> {
    if (ownerType === 'profile') {
      return Boolean(
        await this.database.profile.findFirst({
          where: { id: ownerId, accountId },
          select: { id: true },
        }),
      );
    }
    return Boolean(
      await this.database.resume.findFirst({
        where: { id: ownerId, profile: { accountId } },
        select: { id: true },
      }),
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
    await transaction.profile.create({
      data: {
        id: profileId,
        accountId,
        formalRole,
        timezone: input.timezone,
      },
    });
    await transaction.profileVersion.create({
      data: {
        id: uuidv7(),
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
    await transaction.resume.create({
      data: {
        id: resumeId,
        profileId,
        slot: 0,
        isSearchVisible: true,
      },
    });
    return { profileId, resumeId };
  }
}
