import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { SkillBinding } from './local-operation.js';

export class LocalToolError extends Error { constructor(readonly code: string) { super(code); } }
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export interface PackageFile { path: string; hash: string; bytes: number; executable: boolean }
export interface SkillMetadata extends SkillBinding { name: string; description: string; source: string; compatibility?: string }
interface SkillEntry extends SkillMetadata { root: string; files: PackageFile[] }
export interface SkillPage { catalogVersion: string; skills: SkillMetadata[]; nextCursor: string | null; diagnostics: { source: string; code: string }[]; complete: boolean }
export interface LoadedSkill extends SkillMetadata { content: string; resources: PackageFile[]; skillDir: '@skill'; resourcesTruncated: boolean }
export interface SkillResource { skillId: string; skillVersion: string; path: string; hash: string; content: string; nextOffset: number | null }
export interface RegistryOptions { roots?: string[]; snapshotRoot: string; maxSkills?: number; maxFiles?: number; maxFileBytes?: number; maxPackageBytes?: number; scanTimeoutMs?: number }
const defaults = { maxSkills: 200, maxFiles: 1500, maxFileBytes: 2 * 1024 * 1024, maxPackageBytes: 32 * 1024 * 1024, scanTimeoutMs: 10_000 };

/** One immutable startup catalog. Model context is progressive; content hashes bind the entire package. */
export class SkillRegistry {
  readonly catalogVersion: string;
  readonly diagnostics: { source: string; code: string }[];
  readonly complete: boolean;
  private snapshots = new Map<string, Promise<string>>();
  private readonly options: RegistryOptions & typeof defaults;
  private constructor(private readonly entries: SkillEntry[], options: RegistryOptions, diagnostics: SkillRegistry['diagnostics'], complete: boolean, private readonly archived: SkillEntry[] = []) {
    this.options = { ...defaults, ...options }; this.diagnostics = diagnostics; this.complete = complete;
    this.catalogVersion = digest(JSON.stringify(entries.map(e => [e.skillId, e.skillVersion])));
  }
  static async discover(options: RegistryOptions): Promise<SkillRegistry> {
    const opts = { ...defaults, ...options }; const deadline = Date.now() + opts.scanTimeoutMs;
    const entries: SkillEntry[] = [], diagnostics: SkillRegistry['diagnostics'] = [], seen = new Set<string>(); let complete = true;
    const roots = options.roots ?? [join(homedir(), '.agents', 'skills')];
    let count = 0;
    for (const source of roots) {
      let names: string[];
      try { names = await boundedNames(resolve(source), opts.maxSkills + 1); }
      catch (error) { diagnostics.push({ source, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SKILLS_ROOT_MISSING' : 'SKILLS_ROOT_UNREADABLE' }); continue; }
      for (const name of names) {
        if (++count > opts.maxSkills || Date.now() > deadline) { complete = false; diagnostics.push({ source, code: 'SKILLS_SCAN_LIMIT' }); break; }
        const path = join(resolve(source), name);
        try {
          const root = await realpath(path); if (seen.has(root)) continue;
          if (!(await lstat(root)).isDirectory()) continue;
          seen.add(root);
          const files = await packageManifest(root, opts, deadline);
          const content = await readFile(join(root, 'SKILL.md'), 'utf8');
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
          if (!match) throw new LocalToolError('SKILL_METADATA_INVALID');
          const document = parseDocument(match[1]!, { uniqueKeys: true, strict: true });
          if (document.errors.length) throw new LocalToolError('SKILL_METADATA_INVALID');
          const data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
          if (!data || typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64
            || (data.name !== name && data.name !== basename(root)) || typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024
            || data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) throw new LocalToolError('SKILL_METADATA_INVALID');
          // Re-read metadata through its manifest hash: no mixed description and script versions.
          if (files.find(f => f.path === 'SKILL.md')?.hash !== digest(content)) throw new LocalToolError('SKILL_VERSION_CHANGED');
          entries.push({ skillId: `local:${digest(root).slice(0, 20)}`, skillVersion: digest(JSON.stringify(files)), name: data.name,
            description: data.description, source: path, ...(typeof data.compatibility === 'string' ? { compatibility: data.compatibility } : {}), root, files });
        } catch (error) { diagnostics.push({ source: path, code: error instanceof LocalToolError ? error.code : 'SKILL_UNREADABLE' }); }
      }
    }
    const archived: SkillEntry[] = [];
    try {
      const bindings = (await readdir(join(opts.snapshotRoot, 'bindings'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, opts.maxSkills * 5);
      for (const file of bindings) {
        try {
          const raw = await readFile(join(opts.snapshotRoot, 'bindings', file), 'utf8');
          if (raw.length > 512_000) continue;
          const saved = JSON.parse(raw) as SkillEntry;
          if (!/^local:[a-f0-9]{20}$/.test(saved.skillId) || !/^[a-f0-9]{64}$/.test(saved.skillVersion) || !Array.isArray(saved.files)
            || saved.files.length > opts.maxFiles || digest(JSON.stringify(saved.files)) !== saved.skillVersion) continue;
          archived.push({ ...saved, root: join(opts.snapshotRoot, saved.skillVersion) });
        } catch { diagnostics.push({ source: file, code: 'SKILL_BINDING_INVALID' }); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ source: opts.snapshotRoot, code: 'SKILL_BINDINGS_UNREADABLE' }); }
    return new SkillRegistry(entries, opts, diagnostics, complete, archived);
  }
  list({ query, cursor }: { query?: string; cursor?: string } = {}): SkillPage {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new LocalToolError('SKILL_CURSOR_INVALID');
    const q = query?.trim().toLowerCase();
    const found = q ? this.entries.filter(e => `${e.name} ${e.description}`.toLowerCase().includes(q)) : this.entries;
    const skills = found.slice(offset, offset + 20).map(({ root: _root, files: _files, ...metadata }) => metadata);
    return { catalogVersion: this.catalogVersion, skills, nextCursor: offset + 20 < found.length ? String(offset + 20) : null,
      diagnostics: this.diagnostics.slice(0, 50), complete: this.complete };
  }
  private entry(id: string, version?: string): SkillEntry {
    const matches = this.entries.filter(e => e.skillId === id || e.name === id);
    if (matches.length > 1) throw new LocalToolError('SKILL_AMBIGUOUS');
    const entry = matches[0];
    if (version && (!entry || entry.skillVersion !== version)) {
      const archived = this.archived.find(e => e.skillId === id && e.skillVersion === version);
      if (archived) return archived;
      throw new LocalToolError('SKILL_VERSION_UNAVAILABLE');
    }
    if (!entry) throw new LocalToolError('SKILL_NOT_FOUND');
    return entry;
  }
  async snapshot(id: string, version?: string): Promise<{ entry: SkillMetadata; path: string }> {
    const entry = this.entry(id, version); const key = entry.skillVersion;
    let promise = this.snapshots.get(key);
    if (!promise) { promise = this.publish(entry); this.snapshots.set(key, promise); promise.catch(() => this.snapshots.delete(key)); }
    const path = await promise;
    if (JSON.stringify(await packageManifest(path, this.options, Date.now() + this.options.scanTimeoutMs)) !== JSON.stringify(entry.files)) throw new LocalToolError('SKILL_SNAPSHOT_CORRUPTED');
    await mkdir(join(this.options.snapshotRoot, 'bindings'), { recursive: true, mode: 0o700 });
    const binding = join(this.options.snapshotRoot, 'bindings', `${digest(`${entry.skillId}:${entry.skillVersion}`)}.json`);
    const pending = `${binding}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(entry), { mode: 0o600 }); await rename(pending, binding);
    const { root: _root, files: _files, ...metadata } = entry;
    return { entry: metadata, path };
  }
  private async publish(entry: SkillEntry): Promise<string> {
    await mkdir(this.options.snapshotRoot, { recursive: true, mode: 0o700 });
    const path = join(this.options.snapshotRoot, entry.skillVersion);
    try {
      if (JSON.stringify(await packageManifest(path, this.options, Date.now() + this.options.scanTimeoutMs)) === JSON.stringify(entry.files)) return path;
      throw new LocalToolError('SKILL_SNAPSHOT_CORRUPTED');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (entry.root === path) throw new LocalToolError('SKILL_VERSION_UNAVAILABLE'); }
    const temp = join(this.options.snapshotRoot, `.pending-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      for (const file of entry.files) {
        const source = await safeResource(entry.root, file.path);
        await mkdir(join(temp, file.path, '..'), { recursive: true });
        await copyFile(source, join(temp, file.path), constants.COPYFILE_EXCL);
        const data = await readFile(join(temp, file.path));
        if (digest(data) !== file.hash) throw new LocalToolError('SKILL_VERSION_CHANGED');
        await chmod(join(temp, file.path), file.executable ? 0o555 : 0o444);
      }
      const current = await packageManifest(entry.root, this.options, Date.now() + this.options.scanTimeoutMs);
      if (JSON.stringify(current) !== JSON.stringify(entry.files)) throw new LocalToolError('SKILL_VERSION_CHANGED');
      await rename(temp, path); // Atomic publication; one service instance owns this runtime.
      await readonlyDirectories(path);
      return path;
    } catch (error) { await rm(temp, { force: true, recursive: true }); throw error; }
  }
  async load(id: string, version?: string): Promise<LoadedSkill> {
    const { entry, path } = await this.snapshot(id, version); const internal = this.entry(id, version);
    const content = await readFile(join(path, 'SKILL.md'), 'utf8');
    if (content.length > 48_000) throw new LocalToolError('SKILL_BODY_TOO_LARGE');
    return { ...entry, content, resources: internal.files.slice(0, 100), resourcesTruncated: internal.files.length > 100, skillDir: '@skill' };
  }
  async read(id: string, path: string, version: string, offset = 0): Promise<SkillResource> {
    const snapshot = await this.snapshot(id, version);
    const resource = await safeResource(snapshot.path, path);
    const file = this.entry(id, version).files.find(f => f.path === path);
    if (!file) throw new LocalToolError('SKILL_RESOURCE_NOT_FOUND');
    const content = await readFile(resource, 'utf8');
    if (digest(content) !== file.hash) throw new LocalToolError('SKILL_SNAPSHOT_CORRUPTED');
    if (content.includes('\0')) throw new LocalToolError('SKILL_RESOURCE_BINARY');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) throw new LocalToolError('SKILL_OFFSET_INVALID');
    return { skillId: snapshot.entry.skillId, skillVersion: version, path, hash: file.hash, content: content.slice(offset, offset + 24_000),
      nextOffset: offset + 24_000 < content.length ? offset + 24_000 : null };
  }
}
export async function safeResource(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0')) throw new LocalToolError('SKILL_PATH_INVALID');
  const actual = await realpath(resolve(root, path));
  if (!within(root, actual)) throw new LocalToolError('SKILL_PATH_ESCAPE');
  return actual;
}
async function packageManifest(root: string, options: typeof defaults, deadline: number): Promise<PackageFile[]> {
  const files: PackageFile[] = []; let bytes = 0, visitedEntries = 0; const visited = new Set<string>();
  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > 16 || Date.now() > deadline) throw new LocalToolError('SKILL_PACKAGE_LIMIT');
    const real = await realpath(dir); if (!within(root, real)) throw new LocalToolError('SKILL_PATH_ESCAPE');
    if (visited.has(real)) throw new LocalToolError('SKILL_LINK_CYCLE'); visited.add(real);
    const names = await boundedNames(dir, options.maxFiles + 1);
    if (names.length > options.maxFiles) throw new LocalToolError('SKILL_PACKAGE_LIMIT');
    for (const name of names) {
      if (++visitedEntries > options.maxFiles * 2) throw new LocalToolError('SKILL_PACKAGE_LIMIT');
      const path = prefix ? `${prefix}/${name}` : name; const actual = await safeResource(root, path); const stat = await lstat(actual);
      if (stat.isDirectory()) await walk(actual, path, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > options.maxFileBytes || (bytes += stat.size) > options.maxPackageBytes || files.length >= options.maxFiles || Date.now() > deadline) throw new LocalToolError('SKILL_PACKAGE_LIMIT');
        const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content: Buffer;
        try {
          const buffer = Buffer.alloc(Math.min(options.maxFileBytes + 1, stat.size + 1)); let size = 0;
          while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
          if (size > options.maxFileBytes) throw new LocalToolError('SKILL_PACKAGE_LIMIT');
          content = buffer.subarray(0, size);
        } finally { await handle.close(); }
        if (content.length !== stat.size) throw new LocalToolError('SKILL_VERSION_CHANGED');
        files.push({ path, hash: digest(content), bytes: content.length, executable: !!(stat.mode & 0o111) });
      } else throw new LocalToolError('SKILL_SPECIAL_FILE');
    }
    visited.delete(real);
  }
  await walk(root, '', 0); return files;
}
async function readonlyDirectories(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await readonlyDirectories(join(path, entry.name));
  await chmod(path, 0o555);
}

async function boundedNames(path: string, limit: number): Promise<string[]> {
  const directory = await opendir(path); const names: string[] = [];
  try { while (names.length < limit) { const entry = await directory.read(); if (!entry) return names.sort(); names.push(entry.name); } }
  finally { await directory.close(); }
  return names.sort();
}
