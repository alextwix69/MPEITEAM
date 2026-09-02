import createClient from 'openapi-fetch';
import type { paths } from './generated';

export const apiClient = createClient<paths>({ baseUrl: '/api/v1' });
