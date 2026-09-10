import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AccountContactService, EMAIL_SENDER, type EmailSender } from '../modules/identity';
import { NotificationsService } from '../modules/notifications';
import type { WorkerEnvironment } from '../platform/config/env.schema';
import type { JsonLogger } from '../platform/observability/json-logger';
import { WORKER_ENVIRONMENT, WORKER_LOGGER } from './worker.tokens';

@Injectable()
export class EmailDeliveryWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer?: NodeJS.Timeout;
  #running?: Promise<void>;
  #stopping = false;

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(WORKER_LOGGER) private readonly logger: JsonLogger,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AccountContactService) private readonly contacts: AccountContactService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
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
    }, this.environment.OUTBOX_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      const delivery = await this.notifications.claimEmailDelivery();
      if (!delivery) return;
      try {
        const recipient = await this.contacts.activeEmail(delivery.recipientAccountId);
        if (!recipient || !this.emailSender.sendModerationResultEmail) {
          throw new Error('EMAIL_RECIPIENT_UNAVAILABLE');
        }
        const contentUrl = new URL(
          delivery.payload.contentType === 'profile'
            ? '/account/profile'
            : `/account/resumes/${delivery.payload.contentId}`,
          this.environment.PUBLIC_APP_URL,
        ).toString();
        await this.emailSender.sendModerationResultEmail({
          eventId: delivery.providerMessageKey,
          recipient,
          approved: delivery.payload.approved,
          contentType: delivery.payload.contentType,
          contentUrl,
          violationCodes: delivery.payload.violationCodes,
          ...(delivery.payload.reason ? { reason: delivery.payload.reason } : {}),
        });
        await this.notifications.completeEmailDelivery(delivery);
      } catch {
        await this.notifications.failEmailDelivery(delivery);
        this.logger.warn('Доставка moderation email будет повторена.', 'EmailDeliveryWorker');
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}
