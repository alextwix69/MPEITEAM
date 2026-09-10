import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../../platform/database/database.service';
import { ApplicationError } from '../../../platform/http/application-error';
import type { TagCatalogView } from '../catalog.types';

@Injectable()
export class CatalogService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getActiveCatalog(category?: string): Promise<TagCatalogView> {
    const version = await this.database.catalogVersion.findFirst({
      where: { state: 'active' },
      include: {
        tags: {
          where: category ? { category } : undefined,
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!version) {
      throw new ApplicationError(
        'TAG_CATALOG_UNAVAILABLE',
        'Справочник тегов временно недоступен. Повторите попытку позже.',
        503,
        true,
      );
    }
    return {
      version: version.version,
      items: version.tags.map(({ id, code, name, category: tagCategory, sortOrder }) => ({
        id,
        code,
        name,
        category: tagCategory,
        sortOrder,
      })),
    };
  }

  async assertActiveTags(transaction: Prisma.TransactionClient, tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const count = await transaction.catalogTag.count({
      where: {
        id: { in: tagIds },
        catalogVersion: { state: 'active' },
      },
    });
    if (count !== tagIds.length) {
      throw new ApplicationError(
        'TAG_NOT_FOUND',
        'Один или несколько тегов больше недоступны. Обновите справочник и повторите попытку.',
        422,
      );
    }
  }
}
