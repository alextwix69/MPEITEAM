import { describe, expect, it, vi } from 'vitest';
import type { AccountContactService, EmailSender } from '../../src/modules/identity';
import type { ClaimedEmailDelivery, NotificationsService } from '../../src/modules/notifications';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { EmailDeliveryWorkerService } from '../../src/worker/email-delivery-worker.service';

const environment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WORKER_DATABASE_URL: 'postgresql://user:pass@localhost/db?connection_limit=2',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'secret',
  LEGAL_SUBJECT_HMAC_KEY: 'email-worker-legal-key-00000000001',
  PUBLIC_APP_URL: 'http://localhost:8080',
});

function delivery(): ClaimedEmailDelivery {
  return {
    id: crypto.randomUUID(),
    sourceEventId: crypto.randomUUID(),
    recipientAccountId: crypto.randomUUID(),
    providerMessageKey: `moderation-${crypto.randomUUID()}`,
    attemptCount: 1,
    rowVersion: 1n,
    payload: {
      approved: false,
      contentType: 'profile',
      contentId: crypto.randomUUID(),
      violationCodes: ['profanity'],
      reason: 'Исправьте текст.',
    },
  };
}

describe('moderation email delivery', () => {
  it('uses the stable message key and completes a claimed delivery', async () => {
    const claimed = delivery();
    const completeEmailDelivery = vi.fn(async () => undefined);
    const notifications = {
      claimEmailDelivery: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValueOnce(undefined),
      completeEmailDelivery,
      failEmailDelivery: vi.fn(),
    } as unknown as NotificationsService;
    const contacts = {
      activeEmail: vi.fn(async () => 'student@mpei.ru'),
    } as unknown as AccountContactService;
    const sendModerationResultEmail = vi.fn(async () => undefined);
    const sender = {
      sendVerificationEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn(),
      sendModerationResultEmail,
      close: vi.fn(),
    } satisfies EmailSender;
    const worker = new EmailDeliveryWorkerService(
      environment,
      new JsonLogger('worker', 'silent'),
      notifications,
      contacts,
      sender,
    );
    await worker.onApplicationBootstrap();
    await worker.onApplicationShutdown();
    expect(sendModerationResultEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: claimed.providerMessageKey,
        recipient: 'student@mpei.ru',
        violationCodes: ['profanity'],
      }),
    );
    expect(completeEmailDelivery).toHaveBeenCalledWith(claimed);
  });
});
