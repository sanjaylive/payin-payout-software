import { z } from 'zod';

/**
 * File storage backends (docs/FILE_STORAGE.md). Each kind has a strict config schema (non-secret,
 * shown to admins) and a secret schema (encrypted, write-only).
 */

export const STORAGE_KINDS = ['S3', 'GOOGLE_DRIVE', 'LOCAL'] as const;
export type StorageKindKey = (typeof STORAGE_KINDS)[number];

const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300);

export const s3StorageConfigSchema = z.strictObject({
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'S3 bucket name: 3–63 lowercase letters, digits, dots and hyphens'),
  region: z.string().trim().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'AWS region, e.g. ap-south-1'),
  /** S3-compatible services (Cloudflare R2, MinIO, SeaweedFS). Empty for Amazon S3. */
  endpoint: z
    .string()
    .trim()
    .max(200)
    .refine((u) => u === '' || /^https?:\/\/[^\s/?#]+(:\d+)?\/?$/.test(u), 'A base URL like https://<account>.r2.cloudflarestorage.com')
    .default(''),
  force_path_style: z.boolean().default(false),
  /** Folder inside the bucket, e.g. pay2all/ (optional). */
  prefix: z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z0-9_-]+\/)*$/, 'Folder names separated by /, ending with / (e.g. pay2all/)')
    .max(100)
    .default(''),
  /** Server-side encryption on top of Pay2All's own file encryption. */
  sse: z.enum(['', 'AES256', 'aws:kms']).default(''),
  kms_key_id: z.string().trim().max(200).default(''),
  /** Use the host's IAM role (EC2/ECS/EKS) instead of stored access keys. */
  use_instance_role: z.boolean().default(false),
});
export const s3StorageSecretSchema = z.strictObject({
  access_key_id: z.string().trim().min(3).max(128),
  secret_access_key: z.string().trim().min(8).max(256),
});

export const googleDriveConfigSchema = z.strictObject({
  /** The folder files go into — ideally inside a Shared Drive (service accounts have no storage of their own). */
  folder_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{10,120}$/, 'The folder ID from its Drive URL (…/folders/<ID>)'),
  /** Google Workspace domain-wide delegation: act as this user (optional). */
  impersonate_user: z.union([z.literal(''), z.email()]).default(''),
});
/** The service account's JSON key file, as downloaded from Google Cloud. Only the needed fields are kept. */
export const googleDriveSecretSchema = z
  .object({
    type: z.literal('service_account', { error: 'Upload a service account key (type "service_account")' }),
    client_email: z.email().max(254),
    private_key: z.string().min(100).max(8000).includes('PRIVATE KEY', { message: 'private_key must be a PEM private key' }),
    private_key_id: z.string().max(100).optional(),
    project_id: z.string().max(100).optional(),
  })
  .transform((s) => ({ type: s.type, client_email: s.client_email, private_key: s.private_key, private_key_id: s.private_key_id ?? '', project_id: s.project_id ?? '' }));

export const localStorageConfigSchema = z.strictObject({
  /** Sub-directory under the server's LOCAL_STORAGE_ROOT. */
  directory: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}(?:\/[A-Za-z0-9_-]{1,40}){0,3}$/, 'Folder names (letters, digits, - and _) separated by /')
    .default('pay2all'),
});
export const localStorageSecretSchema = z.strictObject({});

export const STORAGE_SCHEMAS = {
  S3: { config: s3StorageConfigSchema, secret: s3StorageSecretSchema },
  GOOGLE_DRIVE: { config: googleDriveConfigSchema, secret: googleDriveSecretSchema },
  LOCAL: { config: localStorageConfigSchema, secret: localStorageSecretSchema },
} as const;

/** Config fields that say where existing files are; locked while the backend holds files. */
export const STORAGE_LOCATION_FIELDS: Record<StorageKindKey, readonly string[]> = {
  S3: ['bucket', 'region', 'endpoint', 'prefix', 'force_path_style'],
  GOOGLE_DRIVE: ['folder_id'],
  LOCAL: ['directory'],
};

/** Body is kind-specific; config and secret are validated against the kind in the API. */
export const saveStorageBackendSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  config: z.record(z.string(), z.unknown()),
  /** Omit to keep the stored credentials. */
  secret: z.record(z.string(), z.unknown()).optional(),
  reason,
});

export const activateStorageSchema = z.strictObject({
  /** DEFAULT = the server's environment S3. */
  kind: z.enum([...STORAGE_KINDS, 'DEFAULT']),
  reason,
});

export const removeStorageBackendSchema = z.strictObject({ reason });
