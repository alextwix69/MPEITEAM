import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { Access } from '../http/route-access';

@Access('public')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('live')
  liveness(): { status: 'ok' } {
    return this.healthService.liveness();
  }

  @Get('ready')
  async readiness(@Res({ passthrough: true }) response: Response) {
    const result = await this.healthService.readiness();
    response.status(result.status === 'unavailable' ? 503 : 200);
    return result;
  }
}
