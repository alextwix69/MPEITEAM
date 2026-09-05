import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ROUTE_ACCESS, type RouteAccess } from '../../../platform/http/route-access';
import { IdentityService } from '../application/identity.service';
import { sessionFromCookie } from './session-cookie';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const access =
      this.reflector.getAllAndOverride<RouteAccess>(ROUTE_ACCESS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'active';
    if (access === 'public' || access === 'logout') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const secret = sessionFromCookie(request.headers.cookie);
    await this.identity.authorizeSession(secret, access === 'active');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      await this.identity.validateCsrf(secret, request.get('origin'), request.get('x-csrf-token'));
    }
    return true;
  }
}
