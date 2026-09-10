import { Controller, Get, Headers, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../platform/http/application-error';
import { CatalogService } from '../application/catalog.service';

const categorySchema = z.string().trim().min(1).max(120).optional();

@Controller('catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('tags')
  async listTags(
    @Query('category') categoryValue: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = categorySchema.safeParse(categoryValue);
    if (!parsed.success) {
      throw new ApplicationError('INVALID_REQUEST', 'Укажите корректную категорию тегов.', 422);
    }
    const category = parsed.data;
    const body = await this.catalog.getActiveCatalog(category);
    const etag = `"${createHash('sha256')
      .update(`${body.version}:${category ?? '*'}`)
      .digest('base64url')}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, max-age=300');
    if (ifNoneMatch === etag) {
      response.status(304);
      return;
    }
    return body;
  }
}
