import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { WorkerEnvironment } from '../../../platform/config/env.schema';
import { DatabaseService } from '../../../platform/database/database.service';
import { TRUST_ENVIRONMENT } from '../trust.tokens';
import type { ClaimedModerationRequest, ModerationProviderResult } from '../trust.types';

const requestPayloadSchema = z
  .object({
    contentType: z.enum(['profile_version', 'resume_version']),
    contentVersionId: z.uuid(),
    ownerAccountId: z.uuid(),
  })
  .strict();

type DecisionEffect = (
  transaction: Prisma.TransactionClient,
  decisionId: string,
  result: ModerationProviderResult,
) => Promise<void>;

@Injectable()
export class TrustService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TRUST_ENVIRONMENT) private readonly environment: WorkerEnvironment,
  ) {}

  async consumeModerationRequest(event: {
    id: string;
    eventVersion: number;
    payload: unknown;
  }): Promise<void> {
    if (event.eventVersion !== 1) throw new Error('EVENT_VERSION_UNSUPPORTED');
    const payload = requestPayloadSchema.parse(event.payload);
    await this.database.$transaction(async (transaction) => {
      const inbox = await transaction.$executeRaw`
        INSERT INTO trust.inbox_events (event_id, consumer, event_version, processed_at)
        VALUES (${event.id}::uuid, 'trust.automated-moderation', 1, now())
        ON CONFLICT (event_id) DO NOTHING
      `;
      if (inbox !== 1) return;
      const requestId = uuidv7();
      const request = await transaction.moderationRequest.upsert({
        where: {
          contentType_contentVersionId_policyVersion: {
            contentType: payload.contentType,
            contentVersionId: payload.contentVersionId,
            policyVersion: this.environment.MODERATION_POLICY_VERSION,
          },
        },
        create: {
          id: requestId,
          contentType: payload.contentType,
          contentVersionId: payload.contentVersionId,
          ownerAccountId: payload.ownerAccountId,
          policyVersion: this.environment.MODERATION_POLICY_VERSION,
          providerRequestKey: `moderation:${requestId}:g1:primary`,
          pendingSince: new Date(),
        },
        update: {},
      });
      await transaction.trustInboxEvent.update({
        where: { eventId: event.id },
        data: { resultRefId: request.id },
      });
    });
  }

  async claimNext(): Promise<ClaimedModerationRequest | undefined> {
    const now = new Date();
    const candidate = await this.database.moderationRequest.findFirst({
      where: {
        OR: [{ state: 'pending' }, { state: 'in_progress', leaseUntil: { lt: now } }],
      },
      orderBy: [{ pendingSince: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) return undefined;
    const generation = candidate.failureCode ? candidate.generation + 1 : candidate.generation;
    const providerRequestKey = `moderation:${candidate.id}:g${generation}:primary`;
    const claimed = await this.database.moderationRequest.updateMany({
      where: {
        id: candidate.id,
        rowVersion: candidate.rowVersion,
        OR: [{ state: 'pending' }, { state: 'in_progress', leaseUntil: { lt: now } }],
      },
      data: {
        state: 'in_progress',
        generation,
        activeEndpoint: 'primary',
        providerRequestKey,
        leaseUntil: new Date(
          Date.now() + Math.max(30_000, this.environment.MODERATION_TIMEOUT_MS * 3),
        ),
        failureCode: null,
        rowVersion: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return undefined;
    return {
      id: candidate.id,
      contentType: candidate.contentType as ClaimedModerationRequest['contentType'],
      contentVersionId: candidate.contentVersionId,
      ownerAccountId: candidate.ownerAccountId,
      policyVersion: candidate.policyVersion,
      generation,
      endpoint: 'primary',
      providerRequestKey,
      rowVersion: candidate.rowVersion + 1n,
    };
  }

  async switchToSecondary(
    claimed: ClaimedModerationRequest,
  ): Promise<ClaimedModerationRequest | undefined> {
    const generation = claimed.generation + 1;
    const providerRequestKey = `moderation:${claimed.id}:g${generation}:secondary`;
    const changed = await this.database.moderationRequest.updateMany({
      where: {
        id: claimed.id,
        state: 'in_progress',
        generation: claimed.generation,
        activeEndpoint: claimed.endpoint,
        rowVersion: claimed.rowVersion,
      },
      data: {
        generation,
        activeEndpoint: 'secondary',
        providerRequestKey,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) return undefined;
    return {
      ...claimed,
      generation,
      endpoint: 'secondary',
      providerRequestKey,
      rowVersion: claimed.rowVersion + 1n,
    };
  }

  async release(claimed: ClaimedModerationRequest): Promise<void> {
    await this.database.moderationRequest.updateMany({
      where: {
        id: claimed.id,
        state: 'in_progress',
        generation: claimed.generation,
        activeEndpoint: claimed.endpoint,
        rowVersion: claimed.rowVersion,
      },
      data: {
        state: 'pending',
        leaseUntil: null,
        failureCode: 'PROVIDERS_UNAVAILABLE',
        pendingSince: new Date(),
        rowVersion: { increment: 1 },
      },
    });
  }

  async complete(
    claimed: ClaimedModerationRequest,
    input: { contentId: string; result: ModerationProviderResult },
    effect: DecisionEffect,
  ): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.moderationRequest.updateMany({
        where: {
          id: claimed.id,
          state: 'in_progress',
          generation: claimed.generation,
          activeEndpoint: claimed.endpoint,
          rowVersion: claimed.rowVersion,
        },
        data: {
          state: input.result.approved ? 'approved' : 'rejected',
          violationCodes: input.result.violationCodes,
          decidedAt: new Date(),
          leaseUntil: null,
          rowVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1) return false;
      const decisionId = uuidv7();
      await transaction.moderationDecision.create({
        data: {
          id: decisionId,
          sourceId: claimed.id,
          contentType: claimed.contentType === 'profile_version' ? 'profile' : 'resume',
          contentId: input.contentId,
          contentVersionId: claimed.contentVersionId,
          outcome: input.result.approved ? 'approved' : 'return_for_revision',
          policyVersion: claimed.policyVersion,
          violationCodes: input.result.violationCodes,
          reason: input.result.reason,
          decidedAt: new Date(),
        },
      });
      await effect(transaction, decisionId, input.result);
      return true;
    });
  }
}
