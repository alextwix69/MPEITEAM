export type ModerationEndpointName = 'primary' | 'secondary';

export interface ModerationProviderInput {
  providerRequestKey: string;
  policyVersion: string;
  text: string;
  mediaUrl?: string;
}

export interface ModerationProviderResult {
  approved: boolean;
  violationCodes: string[];
  reason?: string;
}

export interface ContentModerator {
  moderate(
    endpoint: ModerationEndpointName,
    input: ModerationProviderInput,
  ): Promise<ModerationProviderResult>;
}

export interface ClaimedModerationRequest {
  id: string;
  contentType: 'profile_version' | 'resume_version';
  contentVersionId: string;
  ownerAccountId: string;
  policyVersion: string;
  generation: number;
  endpoint: ModerationEndpointName;
  providerRequestKey: string;
  rowVersion: bigint;
}
