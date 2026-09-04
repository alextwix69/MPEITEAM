import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ComposeService {
  depends_on?: Record<string, { condition?: string }>;
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

describe('local degraded startup', () => {
  it.each(['api', 'worker'])('%s is not startup-gated by Redis or object storage', (role) => {
    const compose = parse(
      readFileSync(resolve(__dirname, '..', '..', 'docker-compose.yml'), 'utf8'),
    ) as ComposeDocument;
    const dependencies = Object.keys(compose.services?.[role]?.depends_on ?? {});

    expect(dependencies).not.toContain('redis');
    expect(dependencies).not.toContain('minio');
    expect(dependencies).not.toContain('minio-setup');
  });

  it('does not include query secrets in reverse-proxy access logs', () => {
    const nginx = readFileSync(
      resolve(__dirname, '..', '..', 'infra', 'nginx', 'default.conf'),
      'utf8',
    );

    expect(nginx).toContain('$request_method $uri $server_protocol');
    expect(nginx).not.toMatch(/log_format[^;]*\$request_uri/su);
    expect(nginx).not.toMatch(/log_format[^;]*\$request(?:\s|')/su);
    expect(nginx).not.toMatch(/log_format[^;]*\$http_referer/su);
    expect(nginx).toContain('add_header Referrer-Policy "no-referrer" always;');
  });
});
