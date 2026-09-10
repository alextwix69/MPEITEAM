export interface TagView {
  id: string;
  code: string;
  name: string;
  category: string;
  sortOrder: number;
}

export interface TagCatalogView {
  version: string;
  items: TagView[];
}
