export interface UploadRateLimiter {
  consume(accountId: string, ipAddress: string): Promise<void>;
}
