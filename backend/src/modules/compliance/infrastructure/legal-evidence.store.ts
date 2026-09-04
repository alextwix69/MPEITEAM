import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { WorkerEnvironment } from '../../../platform/config/env.schema';
import { canonicalJson, hmacSha256, sha256 } from '../../../platform/security/crypto';
import { COMPLIANCE_ENVIRONMENT } from '../compliance.tokens';

const consentPayloadSchema = z
  .object({
    documentType: z.enum(['age_18', 'user_terms', 'personal_data', 'public_profile_distribution']),
    documentVersion: z.string().min(1).max(64),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export interface ConsentEvidenceEvent {
  id: string;
  aggregateId: string;
  payload: unknown;
}

@Injectable()
export class LegalEvidenceStore implements OnApplicationShutdown {
  readonly #pool: Pool;

  constructor(@Inject(COMPLIANCE_ENVIRONMENT) private readonly environment: WorkerEnvironment) {
    this.#pool = new Pool({ connectionString: environment.LEGAL_DATABASE_URL, max: 2 });
  }

  async appendConsentEvidence(event: ConsentEvidenceEvent): Promise<void> {
    const payload = consentPayloadSchema.parse(event.payload);
    const subjectToken = hmacSha256(this.environment.LEGAL_SUBJECT_HMAC_KEY, event.aggregateId);
    const evidenceHash = sha256(
      canonicalJson({
        subjectToken: subjectToken.toString('hex'),
        documentType: payload.documentType,
        documentVersion: payload.documentVersion,
        action: 'accepted',
        occurredAt: payload.occurredAt,
      }),
    );
    const occurredAt = new Date(payload.occurredAt);
    await this.#pool.query(
      `INSERT INTO legal.consent_evidence
        (id, subject_token, document_type, document_version, action, occurred_at, source_event_id, evidence_hash, retention_until)
       VALUES ($1::uuid, $2, $3, $4, 'accepted', $5, $6::uuid, $7, $5::timestamptz + interval '3 years')
       ON CONFLICT (source_event_id) DO NOTHING`,
      [
        uuidv7(),
        subjectToken,
        payload.documentType,
        payload.documentVersion,
        occurredAt,
        event.id,
        evidenceHash,
      ],
    );
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.#pool.query(
      'DELETE FROM legal.consent_evidence WHERE retention_until <= $1',
      [now],
    );
    return result.rowCount ?? 0;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#pool.end();
  }
}
