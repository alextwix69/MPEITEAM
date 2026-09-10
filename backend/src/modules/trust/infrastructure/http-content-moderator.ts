import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { WorkerEnvironment } from '../../../platform/config/env.schema';
import { normalizeViolationCodes } from '../policy';
import { TRUST_ENVIRONMENT } from '../trust.tokens';
import type {
  ContentModerator,
  ModerationEndpointName,
  ModerationProviderInput,
  ModerationProviderResult,
} from '../trust.types';

const responseSchema = z
  .object({
    approved: z.boolean(),
    violationCodes: z.array(z.string().min(1).max(100)).max(35).default([]),
    reason: z.string().max(2000).optional(),
  })
  .strict();

interface CircuitState {
  failures: number;
  openedUntil: number;
}

@Injectable()
export class HttpContentModerator implements ContentModerator {
  readonly #circuits: Record<ModerationEndpointName, CircuitState> = {
    primary: { failures: 0, openedUntil: 0 },
    secondary: { failures: 0, openedUntil: 0 },
  };

  constructor(@Inject(TRUST_ENVIRONMENT) private readonly environment: WorkerEnvironment) {}

  async moderate(
    endpoint: ModerationEndpointName,
    input: ModerationProviderInput,
  ): Promise<ModerationProviderResult> {
    const circuit = this.#circuits[endpoint];
    if (circuit.openedUntil > Date.now()) throw new Error('MODERATION_CIRCUIT_OPEN');
    const url = new URL(
      endpoint === 'primary'
        ? this.environment.MODERATION_PRIMARY_URL
        : this.environment.MODERATION_SECONDARY_URL,
    );
    try {
      const result = url.hostname.startsWith('local-moderator')
        ? this.localResult(input)
        : await this.remoteResult(url, input);
      circuit.failures = 0;
      circuit.openedUntil = 0;
      return {
        approved: result.approved,
        violationCodes: normalizeViolationCodes(result.violationCodes),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      circuit.failures += 1;
      if (circuit.failures >= this.environment.MODERATION_CIRCUIT_FAILURES) {
        circuit.openedUntil = Date.now() + this.environment.MODERATION_CIRCUIT_RESET_MS;
      }
      throw error;
    }
  }

  private localResult(input: ModerationProviderInput) {
    const marker = /\[\[reject:([a-z0-9_]+)\]\]/u.exec(input.text);
    return responseSchema.parse(
      marker
        ? {
            approved: false,
            violationCodes: [marker[1]],
            reason:
              'Материал нарушает правила публикации. Исправьте указанный фрагмент и отправьте его повторно.',
          }
        : { approved: true, violationCodes: [] },
    );
  }

  private async remoteResult(url: URL, input: ModerationProviderInput) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': input.providerRequestKey,
      },
      body: JSON.stringify({
        policyVersion: input.policyVersion,
        text: input.text,
        ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
      }),
      signal: AbortSignal.timeout(this.environment.MODERATION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('MODERATION_PROVIDER_UNAVAILABLE');
    return responseSchema.parse(await response.json());
  }
}
