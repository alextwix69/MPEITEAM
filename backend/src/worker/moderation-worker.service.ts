import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { FilesService } from '../modules/files';
import { ProfilesService } from '../modules/profiles';
import {
  CONTENT_MODERATOR,
  TrustService,
  type ClaimedModerationRequest,
  type ContentModerator,
  type ModerationProviderResult,
} from '../modules/trust';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WORKER_ENVIRONMENT, WORKER_LOGGER } from './worker.tokens';

@Injectable()
export class ModerationWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer?: NodeJS.Timeout;
  #running?: Promise<void>;
  #stopping = false;

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
    @Inject(TrustService) private readonly trust: TrustService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CONTENT_MODERATOR) private readonly moderator: ContentModerator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.poll();
    this.schedule();
  }

  private schedule(): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#running = this.poll()
        .catch(() => undefined)
        .finally(() => {
          this.#running = undefined;
          this.schedule();
        });
    }, this.environment.MODERATION_WORKER_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      const claimed = await this.trust.claimNext();
      if (!claimed) return;
      await this.process(claimed);
    }
  }

  private async process(claimed: ClaimedModerationRequest): Promise<void> {
    const payload = await this.profiles.moderationPayload(
      claimed.contentType,
      claimed.contentVersionId,
    );
    if (!payload) {
      await this.trust.release(claimed);
      return;
    }
    let mediaUrl: string | undefined;
    if (payload.mediaId) mediaUrl = await this.files.createModerationUrl(payload.mediaId);

    let active = claimed;
    let result: ModerationProviderResult;
    try {
      result = await this.moderate(active, payload.text, mediaUrl);
    } catch {
      const secondary = await this.trust.switchToSecondary(active);
      if (!secondary) return;
      active = secondary;
      try {
        result = await this.moderate(active, payload.text, mediaUrl);
      } catch {
        await this.trust.release(active);
        this.logger.warn(
          'Оба endpoint автомодерации недоступны; версия осталась pending.',
          'ModerationWorker',
        );
        return;
      }
    }

    await this.trust.complete(
      active,
      { contentId: payload.contentId, result },
      async (transaction, decisionId, decision) => {
        if (payload.mediaId && mediaUrl) {
          await this.files.applyPublicMediaDecision(
            transaction,
            payload.mediaId,
            decision.approved,
          );
        }
        await this.profiles.applyModerationDecision(transaction, {
          sourceEventId: decisionId,
          decisionId,
          contentType: payload.contentType,
          contentId: payload.contentId,
          contentVersionId: payload.contentVersionId,
          ownerAccountId: payload.ownerAccountId,
          approved: decision.approved,
          policyVersion: active.policyVersion,
          violationCodes: decision.violationCodes,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
      },
    );
  }

  private moderate(claimed: ClaimedModerationRequest, text: string, mediaUrl?: string) {
    return this.moderator.moderate(claimed.endpoint, {
      providerRequestKey: claimed.providerRequestKey,
      policyVersion: claimed.policyVersion,
      text,
      ...(mediaUrl ? { mediaUrl } : {}),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}
