import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { s3StorageConfigSchema, s3StorageSecretSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { type StorageCheck, type StorageDriver, StorageDriverError, timed } from './driver';

type Config = z.output<typeof s3StorageConfigSchema>;
type Secret = z.output<typeof s3StorageSecretSchema>;

/** Amazon S3 or any S3-compatible service (R2, MinIO, SeaweedFS). */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;

  constructor(
    private readonly config: Config,
    secret: Secret | null,
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.force_path_style,
      ...(!config.use_instance_role && secret ? { credentials: { accessKeyId: secret.access_key_id, secretAccessKey: secret.secret_access_key } } : {}),
      maxAttempts: 3,
    });
  }

  private sse() {
    if (!this.config.sse) return {};
    return { ServerSideEncryption: this.config.sse, ...(this.config.sse === 'aws:kms' && this.config.kms_key_id ? { SSEKMSKeyId: this.config.kms_key_id } : {}) };
  }

  async put(name: string, body: Readable): Promise<string> {
    const key = `${this.config.prefix}${name}`;
    try {
      await new Upload({
        client: this.client,
        queueSize: 2,
        partSize: 5 * 1024 * 1024,
        params: { Bucket: this.config.bucket, Key: key, Body: body, ContentType: 'application/octet-stream', ...this.sse() },
      }).done();
    } catch (err) {
      throw explain(err, this.config.bucket);
    }
    return key;
  }

  async get(locator: string): Promise<Readable> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: locator }));
      if (!(res.Body instanceof Readable)) throw new StorageDriverError('Unexpected object body type');
      return res.Body;
    } catch (err) {
      throw explain(err, this.config.bucket);
    }
  }

  async delete(locator: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: locator }));
    } catch (err) {
      throw explain(err, this.config.bucket);
    }
  }

  async precheck(): Promise<StorageCheck[]> {
    try {
      const { ms } = await timed(() => this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket })));
      return [{ name: 'Bucket reachable', ok: true, detail: `${this.config.bucket} (${this.config.endpoint || this.config.region})`, ms }];
    } catch (err) {
      return [{ name: 'Bucket reachable', ok: false, detail: explain(err, this.config.bucket).message }];
    }
  }
}

function explain(err: unknown, bucket: string): StorageDriverError {
  if (err instanceof StorageDriverError) return err;
  const name = err instanceof S3ServiceException ? err.name : err instanceof Error ? ((err as { code?: string }).code ?? err.name) : '';
  const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
  switch (name) {
    case 'NoSuchBucket':
      return new StorageDriverError(`Bucket “${bucket}” does not exist in this region/endpoint`);
    case 'NotFound':
      return new StorageDriverError(status === 404 ? `Bucket “${bucket}” not found` : 'Not found');
    case 'NoSuchKey':
      return new StorageDriverError('File not found in the bucket');
    case 'InvalidAccessKeyId':
      return new StorageDriverError('Access key ID not recognised');
    case 'SignatureDoesNotMatch':
      return new StorageDriverError('Secret access key is wrong');
    case 'AccessDenied':
    case 'Forbidden':
      return new StorageDriverError('Access denied: the key needs s3:PutObject, s3:GetObject, s3:DeleteObject and s3:ListBucket on this bucket');
    case 'PermanentRedirect':
    case 'AuthorizationHeaderMalformed':
      return new StorageDriverError('The bucket is in a different region');
    case 'CredentialsProviderError':
      return new StorageDriverError('No credentials: add an access key, or run on a host with an IAM role');
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return new StorageDriverError(`Cannot reach the storage endpoint (${name})`, true);
    default:
      if (status === 403) return new StorageDriverError('Access denied by the bucket');
      if (status === 400 && name === 'BadRequest') return new StorageDriverError('The bucket rejected the request — check the region');
      return new StorageDriverError(`Storage error${name ? ` (${name})` : ''}`, status === undefined || status >= 500);
  }
}
