import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { FilesEnvironment } from '../files.types';
import { FILES_ENVIRONMENT, OBJECT_STORAGE } from '../files.tokens';
import type { ObjectStorage, StoredObjectMetadata } from '../application/object-storage.port';

@Injectable()
export class S3StorageAdapter implements ObjectStorage, OnApplicationShutdown {
  readonly #client: S3Client;
  readonly #publicClient: S3Client;

  constructor(@Inject(FILES_ENVIRONMENT) private readonly environment: FilesEnvironment) {
    this.#client = new S3Client({
      endpoint: environment.S3_ENDPOINT,
      region: environment.S3_REGION,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY,
        secretAccessKey: environment.S3_SECRET_KEY,
      },
    });
    this.#publicClient = new S3Client({
      endpoint: environment.S3_PUBLIC_ENDPOINT,
      region: environment.S3_REGION,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY,
        secretAccessKey: environment.S3_SECRET_KEY,
      },
    });
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.#publicClient,
      new PutObjectCommand({
        Bucket: this.environment.S3_BUCKET,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<string> {
    return getSignedUrl(
      this.#publicClient,
      new GetObjectCommand({
        Bucket: this.environment.S3_BUCKET,
        Key: input.objectKey,
        ResponseCacheControl: 'no-store',
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async head(objectKey: string): Promise<StoredObjectMetadata | undefined> {
    try {
      const result = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.environment.S3_BUCKET, Key: objectKey }),
      );
      return {
        contentLength: Number(result.ContentLength ?? 0),
        contentType: result.ContentType,
        eTag: result.ETag,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NotFound') return undefined;
      throw error;
    }
  }

  async get(objectKey: string): Promise<Buffer> {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.environment.S3_BUCKET, Key: objectKey }),
    );
    if (!result.Body) throw new Error('OBJECT_BODY_MISSING');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async put(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.environment.S3_BUCKET,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.environment.S3_BUCKET, Key: objectKey }),
    );
  }

  onApplicationShutdown(): void {
    this.#client.destroy();
    this.#publicClient.destroy();
  }
}

export const objectStorageProvider = { provide: OBJECT_STORAGE, useClass: S3StorageAdapter };
