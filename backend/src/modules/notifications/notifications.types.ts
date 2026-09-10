export interface NotificationView {
  id: string;
  type: string;
  resourceType?: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  read: boolean;
  readAt?: string;
  rowVersion: number;
  createdAt: string;
}

export interface ModerationResultEvent {
  id: string;
  eventVersion: number;
  payload: unknown;
}

export interface ClaimedEmailDelivery {
  id: string;
  sourceEventId: string;
  recipientAccountId: string;
  providerMessageKey: string;
  attemptCount: number;
  rowVersion: bigint;
  payload: {
    approved: boolean;
    contentType: 'profile' | 'resume';
    contentId: string;
    violationCodes: string[];
    reason?: string;
  };
}
