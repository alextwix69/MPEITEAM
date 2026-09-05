import { SetMetadata } from '@nestjs/common';

export type RouteAccess = 'public' | 'session' | 'active' | 'logout';
export const ROUTE_ACCESS = 'route-access';
export const Access = (access: RouteAccess) => SetMetadata(ROUTE_ACCESS, access);
