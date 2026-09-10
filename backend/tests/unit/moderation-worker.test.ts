import { describe, expect, it, vi } from 'vitest';
import type { FilesService } from '../../src/modules/files';
import type { ProfilesService } from '../../src/modules/profiles';
import type {
  ClaimedModerationRequest,
  ContentModerator,
  TrustService,
} from '../../src/modules/trust';
import { parseWorkerEnvironment } from '../../src/platform/config/env.schema';
import { JsonLogger } from '../../src/platform/observability/json-logger';
import { ModerationWorkerService } from '../../src/worker/moderation-worker.service';

const environment = parseWorkerEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WORKER_DATABASE_URL: 'postgresql://user:pass@localhost/db?connection_limit=2',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'komanda-media',
  S3_ACCESS_KEY: 'local',
  S3_SECRET_KEY: 'secret',
  LEGAL_SUBJECT_HMAC_KEY: 'moderation-test-legal-key-000000001',
});

function request(endpoint: 'primary' | 'secondary' = 'primary'): ClaimedModerationRequest {
  return {
    id: crypto.randomUUID(),
    contentType: 'profile_version',
    contentVersionId: crypto.randomUUID(),
    ownerAccountId: crypto.randomUUID(),
    policyVersion: '2026-08-17',
    generation: endpoint === 'primary' ? 1 : 2,
    endpoint,
    providerRequestKey: `provider-${endpoint}`,
    rowVersion: endpoint === 'primary' ? 1n : 2n,
  };
}

function dependencies(moderator: ContentModerator) {
  const primary = request();
  const secondary = { ...request('secondary'), id: primary.id };
  const claimNext = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(undefined);
  const switchToSecondary = vi.fn(async () => secondary);
  const release = vi.fn(async () => undefined);
  const complete = vi.fn(async (_claimed, input, effect) => {
    await effect({}, crypto.randomUUID(), input.result);
    return true;
  });
  const trust = { claimNext, switchToSecondary, release, complete } as unknown as TrustService;
  const profiles = {
    moderationPayload: vi.fn(async () => ({
      contentType: 'profile_version',
      contentId: crypto.randomUUID(),
      contentVersionId: primary.contentVersionId,
      ownerAccountId: primary.ownerAccountId,
      text: 'Публичный профиль',
    })),
    applyModerationDecision: vi.fn(async () => true),
  } as unknown as ProfilesService;
  const files = {
    createModerationUrl: vi.fn(),
    applyPublicMediaDecision: vi.fn(),
  } as unknown as FilesService;
  return {
    primary,
    secondary,
    trust,
    profiles,
    files,
    complete,
    release,
    switchToSecondary,
    moderator,
  };
}

describe('moderation worker failover', () => {
  it('switches from primary to secondary and commits only the active generation', async () => {
    const moderate = vi
      .fn<ContentModerator['moderate']>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ approved: true, violationCodes: [] });
    const values = dependencies({ moderate });
    const worker = new ModerationWorkerService(
      environment,
      new JsonLogger('worker', 'silent'),
      values.trust,
      values.profiles,
      values.files,
      values.moderator,
    );
    await worker.onApplicationBootstrap();
    await worker.onApplicationShutdown();
    expect(moderate.mock.calls.map(([endpoint]) => endpoint)).toEqual(['primary', 'secondary']);
    expect(values.switchToSecondary).toHaveBeenCalledWith(values.primary);
    expect(values.complete).toHaveBeenCalledWith(
      values.secondary,
      expect.objectContaining({ result: { approved: true, violationCodes: [] } }),
      expect.any(Function),
    );
  });

  it('leaves content pending when both endpoints are unavailable', async () => {
    const moderate = vi.fn<ContentModerator['moderate']>().mockRejectedValue(new Error('offline'));
    const values = dependencies({ moderate });
    const worker = new ModerationWorkerService(
      environment,
      new JsonLogger('worker', 'silent'),
      values.trust,
      values.profiles,
      values.files,
      values.moderator,
    );
    await worker.onApplicationBootstrap();
    await worker.onApplicationShutdown();
    expect(values.release).toHaveBeenCalledWith(values.secondary);
    expect(values.complete).not.toHaveBeenCalled();
  });
});
