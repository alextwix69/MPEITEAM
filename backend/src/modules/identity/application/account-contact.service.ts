import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../platform/database/database.service';

@Injectable()
export class AccountContactService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async activeEmail(accountId: string): Promise<string | undefined> {
    const account = await this.database.account.findFirst({
      where: { id: accountId, state: 'active', emailVerifiedAt: { not: null } },
      select: { emailNormalized: true },
    });
    return account?.emailNormalized;
  }
}
