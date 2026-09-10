import { Module, type DynamicModule } from '@nestjs/common';
import type { RuntimeEnvironment } from '../../platform/config/env.schema';
import { NotificationsService } from './application/notifications.service';
import { NotificationsController } from './http/notifications.controller';
import { NOTIFICATIONS_CURSOR_KEY } from './notifications.tokens';

@Module({})
export class NotificationsModule {
  static register(environment: RuntimeEnvironment, controllers = true): DynamicModule {
    return {
      module: NotificationsModule,
      controllers: controllers ? [NotificationsController] : [],
      providers: [
        NotificationsService,
        { provide: NOTIFICATIONS_CURSOR_KEY, useValue: environment.IDEMPOTENCY_HMAC_KEY },
      ],
      exports: [NotificationsService],
    };
  }
}
