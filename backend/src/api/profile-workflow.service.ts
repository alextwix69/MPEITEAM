import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CatalogService } from '../modules/catalog';
import { FilesService } from '../modules/files';
import { IdentityService } from '../modules/identity';
import {
  ProfilesService,
  type ProfileDependencyChecks,
  type ProfileInput,
  type ResumeInput,
} from '../modules/profiles';
import { ApplicationError } from '../platform/http/application-error';

@Injectable()
export class ProfileWorkflowService implements ProfileDependencyChecks {
  constructor(
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  getOwnProfile(accountId: string) {
    return this.profiles.getOwnProfile(accountId);
  }

  listOwnResumes(accountId: string) {
    return this.profiles.listOwnResumes(accountId);
  }

  getOwnResume(accountId: string, resumeId: string) {
    return this.profiles.getOwnResume(accountId, resumeId);
  }

  async getPublicProfile(accountId: string) {
    if (!(await this.identity.isActiveAccount(accountId))) this.notFound();
    return this.profiles.getPublicProfile(accountId);
  }

  updateOwnProfile(
    accountId: string,
    input: ProfileInput,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    return this.profiles.updateOwnProfile(accountId, input, expectedVersion, idempotencyKey, this);
  }

  updateOwnResume(
    accountId: string,
    resumeId: string,
    input: ResumeInput,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    return this.profiles.updateOwnResume(
      accountId,
      resumeId,
      input,
      expectedVersion,
      idempotencyKey,
      this,
    );
  }

  validateAndBindMedia(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProfileDependencyChecks['validateAndBindMedia']>[1],
  ) {
    return this.files.validateAndBindPublicMedia(transaction, input);
  }

  validateTags(transaction: Prisma.TransactionClient, tagIds: string[]) {
    return this.catalog.assertActiveTags(transaction, tagIds);
  }

  private notFound(): never {
    throw new ApplicationError('RESOURCE_NOT_FOUND', 'Запрошенный профиль не найден.', 404);
  }
}
