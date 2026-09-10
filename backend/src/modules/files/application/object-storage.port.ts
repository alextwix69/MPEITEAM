export interface StoredObjectMetadata {
  contentLength: number;
  contentType?: string;
  eTag?: string;
}

export interface ObjectStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;
  createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<string>;
  head(objectKey: string): Promise<StoredObjectMetadata | undefined>;
  get(objectKey: string): Promise<Buffer>;
  put(objectKey: string, body: Buffer, contentType: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
}
