import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerEnvironment } from '../../platform/config/env.schema';
import { COMPLIANCE_ENVIRONMENT } from './compliance.tokens';
import { LegalEvidenceStore } from './infrastructure/legal-evidence.store';

@Module({})
export class ComplianceModule {
  static register(environment: WorkerEnvironment): DynamicModule {
    return {
      module: ComplianceModule,
      providers: [LegalEvidenceStore, { provide: COMPLIANCE_ENVIRONMENT, useValue: environment }],
      exports: [LegalEvidenceStore],
    };
  }
}
