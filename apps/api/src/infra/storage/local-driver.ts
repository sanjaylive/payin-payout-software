import { randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { localStorageConfigSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { type StorageCheck, type StorageDriver, StorageDriverError, timed } from './driver';

type Config = z.output<typeof localStorageConfigSchema>;

/**
 * Files on the server's disk under LOCAL_STORAGE_ROOT/<directory>. Suits a single server or a shared
 * volume (NFS/EFS) mounted on every API and jobs node. Files are 0600, directories 0700, writes atomic.
 */
export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(
    root: string,
    private readonly config: Config,
  ) {
    if (!isAbsolute(root)) throw new StorageDriverError('LOCAL_STORAGE_ROOT must be an absolute path');
    this.root = resolve(root);
  }

  /** Resolve a locator, refusing anything that escapes the root. */
  private path(locator: string): string {
    const p = resolve(this.root, locator);
    if (!p.startsWith(this.root + sep)) throw new StorageDriverError('Invalid file location');
    return p;
  }

  async put(name: string, body: Readable): Promise<string> {
    const locator = `${this.config.directory}/${name}`;
    const target = this.path(locator);
    const tmp = `${target}.part-${randomBytes(6).toString('hex')}`;
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(body, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw explain(err);
    }
    return locator;
  }

  async get(locator: string): Promise<Readable> {
    const p = this.path(locator);
    try {
      await access(p, constants.R_OK);
    } catch (err) {
      throw explain(err);
    }
    return createReadStream(p);
  }

  async delete(locator: string): Promise<void> {
    try {
      await unlink(this.path(locator));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw explain(err);
    }
  }

  async precheck(): Promise<StorageCheck[]> {
    const dir = join(this.root, this.config.directory);
    try {
      const { ms } = await timed(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await access(dir, constants.W_OK | constants.R_OK);
      });
      const fs = await statfs(dir);
      const free = Number(fs.bavail) * Number(fs.bsize);
      const checks: StorageCheck[] = [{ name: 'Folder writable', ok: true, detail: dir, ms }];
      checks.push({ name: 'Free space', ok: true, detail: `${formatBytes(free)} free${free > 1024 ** 3 ? '' : ' — less than 1 GB'}` });
      return checks;
    } catch (err) {
      return [{ name: 'Folder writable', ok: false, detail: `${dir}: ${explain(err).message}` }];
    }
  }
}

function explain(err: unknown): StorageDriverError {
  if (err instanceof StorageDriverError) return err;
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return new StorageDriverError('File not found on disk');
    case 'EACCES':
    case 'EPERM':
      return new StorageDriverError('Permission denied: the server process cannot write here');
    case 'ENOSPC':
      return new StorageDriverError('The disk is full', true);
    case 'EROFS':
      return new StorageDriverError('The disk is read-only');
    default:
      return new StorageDriverError(`Disk error (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`, true);
  }
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
