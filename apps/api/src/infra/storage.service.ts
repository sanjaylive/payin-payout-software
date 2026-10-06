import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ApiConfig } from '../config/api-config';

/**
 * S3-compatible object storage for KYC documents. The database only holds metadata and the object
 * key (docs/DATABASE.md §2.2). Objects are private; reads go through the API, which authorizes and
 * audits each access.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  readonly bucket: string;

  constructor(private readonly config: ApiConfig) {
    const env = config.env;
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } } : {}),
    });
  }

  /** Development convenience: create the bucket if missing. Production buckets are provisioned by IaC. */
  async onModuleInit(): Promise<void> {
    if (this.config.isProduction) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log({ bucket: this.bucket }, 'Created storage bucket');
      } catch (err) {
        this.logger.warn({ err, bucket: this.bucket }, 'Storage bucket unavailable; document uploads will fail');
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string, sha256Hex: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        Metadata: { sha256: sha256Hex },
        ...(this.config.env.S3_SSE ? { ServerSideEncryption: this.config.env.S3_SSE as 'AES256' } : {}),
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!(res.Body instanceof Readable)) throw new Error('Unexpected object body type');
    return res.Body;
  }
}
