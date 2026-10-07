# File storage

KYC documents, reconciliation files and report exports are stored as files. The database holds their metadata and an object **key** (e.g. `merchants/<id>/documents/<doc>.pdf`). Super admins choose where the files live in **Admin → Settings → File Storage** (`system.settings.manage`).

| Option | Use it for |
| --- | --- |
| **Server default** | The S3 bucket set in the server's environment (`S3_*`). This is what was used before this setting existed, and what is used while nothing else is chosen. |
| **Amazon S3** | Your own AWS bucket, or an S3-compatible service (Cloudflare R2, MinIO, SeaweedFS). Recommended for production. |
| **Google Drive** | A folder in a Google Workspace **Shared Drive**, accessed through a service account. |
| **Local disk** | A folder on the server. Use it only with a single server, or with a shared volume mounted on every API and jobs server. |

## 1. Choosing and switching

- **One option at a time:** exactly one option receives **new** files, enforced by a partial unique index.
- **Switching requires a passing test:** switching runs a live connection test first. If the test fails, nothing changes.
- **Switching never moves files.** `storage_objects` records the backend that holds each file, and the file is always read back from there. Files written before backends existed have no row and are read from the server default bucket.
- **Locked location:** while a backend holds files, its location fields are locked:
  - S3: bucket, region, endpoint, folder and path-style setting;
  - Google Drive: folder ID;
  - Local disk: directory.

  To move to a new location, set it up as a different option. Credentials and other settings can still change.
- **Editing the backend in use:** new values must pass the connection test before they are saved, so a mistake cannot break uploads.
- **Removing:** a backend can be removed only when it is not in use and holds no files.
- **How quickly a switch applies:** the node that made the change switches immediately; other API and jobs nodes pick it up within 10 seconds.
- **Audit:** every change needs a reason and is audited (`storage.backend.*`, `storage.active_changed`). Switching and credential changes are logged as HIGH severity.

## 2. Encryption

Every file written through a chosen backend is **encrypted by Pay2All before it leaves the server**. The storage provider only ever holds ciphertext.

- **Per-file key:** each file gets its own random AES-256-GCM data key and IV. The data key is wrapped with the platform key, using the same keyring as other encrypted fields, with AAD `storage-object:<key>`.
- **What the database stores:** the wrapped key, IV and authentication tag are kept in `storage_objects`. Backups of the files alone are therefore unreadable, and so are backups of the database alone. Keep both.
- **Tamper detection:** a modified or truncated file fails authentication and is not served.
- **Opaque names:** stored files are named `YYYY/MM/<uuid>.bin`, so nothing about merchants or documents shows up in the bucket or folder.
- **S3 server-side encryption:** SSE-S3 or SSE-KMS can be added on top.
- **Credentials:** credentials (S3 keys, the Google service account key) are encrypted with AAD `storage:<id>`. They are write-only: the page shows only the key names, the last 4 characters, and the service account's email.

The server default bucket keeps its previous behaviour: no Pay2All encryption, with `S3_SSE` server-side encryption required in production.

## 3. Setting up

### 3.1 Amazon S3
1. Create a **private** bucket (Block Public Access on) in `ap-south-1` (Mumbai), or the region nearest your servers.
2. Create an IAM user (or role) limited to that bucket: `s3:ListBucket` on the bucket, plus `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `bucket/*`. The page shows the exact policy, ready to copy.
3. Enter the bucket, region and access key, then **Save** and **Test connection**. The test checks the bucket, then writes, reads back and deletes a 64 KB encrypted file.
4. **Use for new files.**

**Options:**
- **Folder in bucket:** keeps Pay2All's files apart in a shared bucket.
- **Server-side encryption:** SSE-S3 or SSE-KMS, with an optional KMS key.
- **Server's IAM role:** on EC2, ECS or EKS, no stored keys are needed.
- **S3-compatible services:** set the **endpoint** and usually **path-style** addressing. In production the endpoint must be `https://`.

### 3.2 Google Drive
1. In Google Cloud Console, enable the **Google Drive API** for a project.
2. Create a **service account**, add a **JSON key**, and upload that file on the page. Only `client_email`, `private_key` and the ids are kept.
3. In Google Drive, create a **Shared Drive** and a folder in it, then add the service account's email as **Content manager**.
4. Paste the folder link or ID, then **Save** and **Test connection**. The test checks:
   - the sign-in;
   - the folder (it exists, is a folder, and is writable);
   - that it is in a Shared Drive;
   - a real write, read and delete.

**Notes:**
- **Storage quota:** service accounts have **no Drive storage of their own**, so a folder in a personal My Drive fails with "storageQuotaExceeded". Shared Drives need Google Workspace. Without Workspace, use domain-wide delegation and **Act as user**, which uses that user's storage.
- **Endpoints:** Google's token and API endpoints are fixed in code, never taken from the uploaded key file.
- **Uploads:** uploads use Drive's resumable protocol in 8 MiB chunks, so memory stays bounded for large report exports.
- **Rate limits:** Drive has per-user rate limits. It suits moderate volumes; prefer S3 for high-volume production.

### 3.3 Local disk
- **Location:** files go under `LOCAL_STORAGE_ROOT/<folder>`. The root is an absolute path set in the server's environment; outside production it defaults to `<cwd>/.storage`, which is git-ignored. **In production, local disk is unavailable until `LOCAL_STORAGE_ROOT` is set.** The folder name is validated, so it cannot escape the root.
- **Permissions and writes:** files are `0600` and directories `0700`. Writes go to a temporary file that is then renamed, so a crash never leaves a half-written file.
- **Servers:** use one server, or a shared volume mounted at the same path on **every** API and jobs node.
- **Backups:** back the folder up **together with the database**.

## 4. API

All routes require `system.settings.manage` and platform staff.

| Route | |
| --- | --- |
| `GET /v1/storage/backends` | Which option is in use, server default summary, local availability, each backend (config, credential fingerprints, last test, file count and size) |
| `PUT /v1/storage/backends/:kind` | Create or update `S3` / `GOOGLE_DRIVE` / `LOCAL`: `{ config, secret?, reason }`. Omit `secret` to keep the stored one. |
| `POST /v1/storage/backends/:kind/test` | `{ ok, checks: [{ name, ok, detail, ms }] }` |
| `POST /v1/storage/active` | `{ kind: S3 \| GOOGLE_DRIVE \| LOCAL \| DEFAULT, reason }`. Tests first. |
| `POST /v1/storage/backends/:kind/remove` | `{ reason }`. Only when the backend is not in use and holds no files. |

## 5. Not yet included
- **Migrating existing files** from one backend to another (a background copy job with verification).
- **Lifecycle and retention rules** per backend (expired report exports are already deleted by the jobs process).
