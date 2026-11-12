import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { CliCatalogEntry, CliUsageMetadata } from './cli-catalog.js';
import { cliSearchPath } from './local-cli.js';

export interface CliDiscoveryOptions {
  /** Trusted embedding roots; ordinary service startup uses its effective PATH automatically. */
  paths?: string[];
  hostPaths?: string[];
  sandboxPaths?: string[];
  manRoots?: string[];
  systemPackageRoot?: string;
}
interface Documentation { description: string; source: NonNullable<CliCatalogEntry['documentation']>['source']; reference: string; scope?: 'command' | 'package' }
const files = new Map<string, { version: string; content: Buffer }>();
async function cachedFile(path: string): Promise<Buffer | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const version = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`, previous = files.get(path);
    if (previous?.version === version) return previous.content;
    const content = await readFile(path); files.set(path, { version, content }); return content;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw error;
  }
}
async function concurrently<T, U>(items: T[], map: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(items.length); let cursor = 0;
  // Concurrency controls filesystem pressure; every entry is still processed.
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await map(items[index]!); }
  }));
  return result;
}
const bareCommand = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name);
async function commands(paths: string[]): Promise<{ command: string; path: string; real: string }[]> {
  const found = new Map<string, { command: string; path: string; real: string }>();
  for (const directory of paths) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) continue;
      throw error;
    }
    const candidates = entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && bareCommand(entry.name) && !found.has(entry.name));
    const resolved = await concurrently(candidates, async entry => {
      const path = join(directory, entry.name);
      try { await access(path, constants.X_OK); const real = await realpath(path); if (!(await stat(real)).isFile()) return undefined;
        return { command: entry.name, path, real }; }
      catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
        throw error;
      }
    });
    for (const entry of resolved) if (entry) found.set(entry.command, entry);
  }
  return [...found.values()].sort((a, b) => a.command.localeCompare(b.command, 'en'));
}
async function npmDocumentation(executable: string): Promise<Documentation | undefined> {
  let root = dirname(executable);
  while (true) {
    const content = await cachedFile(join(root, 'package.json'));
    if (content) {
      try {
        const metadata = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
        const bins = typeof metadata.bin === 'string' ? [metadata.bin] : metadata.bin && typeof metadata.bin === 'object' ? Object.values(metadata.bin) : [];
        if (bins.some(bin => typeof bin === 'string' && resolve(root, bin) === executable)
          && typeof metadata.description === 'string' && metadata.description.trim())
          return { description: metadata.description.trim(), source: 'npm', reference: `${String(metadata.name ?? basename(root))}@${String(metadata.version ?? 'unknown')}` };
      } catch { /* Invalid package metadata cannot supply a usage claim. */ }
    }
    const parent = dirname(root); if (parent === root) return undefined; root = parent;
  }
}
function roffText(value: string): string {
  return value.replace(/^\.\".*$/gm, '').replace(/^\.[A-Za-z]+\s*/gm, '').replace(/\\f(?:\[[^\]]*\]|\([A-Za-z]{2}|[A-Za-z])/g, '')
    .replace(/\\[&%]/g, '').replace(/\\-/g, '-').replace(/\\\((?:em|en)/g, '-').replace(/\\\((?:dq|aq)/g, '"')
    .replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}
async function manDocumentation(command: string, roots: string[], belongs: (path: string) => Promise<boolean>): Promise<Documentation | undefined> {
  for (const root of roots) for (const section of ['1', '8', '6']) for (const suffix of ['', '.gz']) {
    const path = join(root, `man${section}`, `${command}.${section}${suffix}`);
    if (!await belongs(path)) continue;
    const content = await cachedFile(path);
    if (!content) continue;
    try {
      const text = (suffix ? gunzipSync(content) : content).toString('utf8');
      const name = text.match(/^\.S[Hh]\s+"?NAME"?\s*\n([\s\S]*?)(?=^\.S[Hh]\s|$(?![\s\S]))/m)?.[1];
      const description = name && roffText(name).replace(new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—]\\s*`, 'i'), '');
      if (description) return { description, source: 'man', reference: `${command}(${section}):${await realpath(path)}` };
    } catch { /* An unreadable manual is not evidence for guessed capabilities. */ }
  }
  return undefined;
}
function manualBinding(entry: { path: string; real: string }, packages: Map<string, Documentation>) {
  const executablePackage = packages.get(entry.real);
  const directory = dirname(entry.real), prefix = ['bin', 'sbin'].includes(basename(directory)) ? dirname(directory) : undefined;
  // Common writable/system prefixes contain unrelated packages. Their same-name
  // manuals need package ownership; dedicated installation trees can use their own share/man.
  const sharedPrefix = prefix && ['/', '/usr', '/usr/local', '/opt/homebrew', '/opt/local'].includes(prefix);
  return async (path: string): Promise<boolean> => {
    let actual: string;
    try { actual = await realpath(path); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) return false; throw error; }
    const manualPackage = packages.get(actual);
    if (executablePackage || manualPackage) return !!executablePackage && manualPackage?.reference === executablePackage.reference;
    if (!prefix || sharedPrefix) return false;
    const pathInInstallation = relative(join(prefix, 'share', 'man'), actual);
    return pathInInstallation !== '' && !pathInInstallation.startsWith('..') && !isAbsolute(pathInInstallation);
  };
}
async function systemDocumentation(root: string, wanted: Set<string>): Promise<Map<string, Documentation>> {
  const status = await cachedFile(join(root, 'status')); const result = new Map<string, Documentation>();
  if (!status) return result;
  const metadata = new Map<string, Documentation>();
  for (const paragraph of status.toString('utf8').split(/\n\s*\n/)) {
    const name = paragraph.match(/^Package:\s*(.+)$/m)?.[1], version = paragraph.match(/^Version:\s*(.+)$/m)?.[1];
    const description = paragraph.match(/^Description:\s*([^\n]*(?:\n[ \t][^\n]*)*)/m)?.[1]?.replace(/\n[ \t]\.\s*/g, '\n').replace(/\n[ \t]/g, '\n').trim();
    if (name && description && /^Status: install ok installed$/m.test(paragraph)) metadata.set(name, { description, source: 'system_package', reference: `dpkg:${name}@${version ?? 'unknown'}`, scope: 'package' });
  }
  let lists: string[];
  try { lists = (await readdir(join(root, 'info'))).filter(name => name.endsWith('.list')); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return result; throw error; }
  await concurrently(lists, async name => {
    const documentation = metadata.get(name.slice(0, -5)) ?? metadata.get(name.slice(0, -5).split(':')[0]!);
    if (!documentation) return;
    const list = await cachedFile(join(root, 'info', name));
    for (const path of list?.toString('utf8').split('\n') ?? []) if (wanted.has(path) || /\/man[168]\//.test(path)) {
      // Debian's short Description is the package purpose, not its entire installation guide.
      // When the package itself lists this command's purpose, prefer that exact documented line.
      const command = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const specific = documentation.description.match(new RegExp(`^\\s*\\*?\\s*${command}\\s+--?\\s+(.+)$`, 'm'))?.[1];
      result.set(path, { ...documentation, description: specific ?? documentation.description.split('\n')[0]!, scope: specific ? 'command' : 'package' });
    }
  });
  return result;
}
async function homebrewDocumentation(executable: string): Promise<Documentation | undefined> {
  const match = executable.match(/^(.*\/Cellar\/([^/]+)\/[^/]+)\//);
  if (!match) return undefined;
  const formula = await cachedFile(join(match[1]!, '.brew', `${match[2]}.rb`));
  const description = formula?.toString('utf8').match(/^\s*desc\s+["']([^"']+)["']/m)?.[1];
  return description ? { description, source: 'homebrew', reference: `homebrew:${match[2]}` } : undefined;
}
/** Enumerate and read static installed metadata only. Never spawn --help, login probes or other commands. */
export async function discoverCliCatalog(options: CliDiscoveryOptions = {}, commandEnv: Record<string, Record<string, string>> = {}): Promise<CliCatalogEntry[]> {
  const pathsFor = (execution: 'host' | 'sandbox') => [...new Set((options[execution === 'host' ? 'hostPaths' : 'sandboxPaths'] ?? options.paths ?? [cliSearchPath(execution)])
    .flatMap(path => path.split(':')).filter(Boolean).map(path => resolve(path)))];
  const roots = options.manRoots ?? [...new Set([...(process.env.MANPATH ?? '').split(':').filter(isAbsolute), '/usr/local/share/man', '/usr/share/man', '/opt/homebrew/share/man'])];
  const [host, sandbox] = await Promise.all([commands(pathsFor('host')), commands(pathsFor('sandbox'))]);
  const variants = { host, sandbox };
  for (const execution of ['host', 'sandbox'] as const) for (const [command, profile] of Object.entries(commandEnv)) {
    if (!profile.PATH || !bareCommand(command)) continue;
    const replacement = (await commands(profile.PATH.split(':').filter(Boolean).map(path => resolve(path)))).find(entry => entry.command === command);
    variants[execution] = variants[execution].filter(entry => entry.command !== command);
    if (replacement) variants[execution].push(replacement);
  }
  const wanted = new Set([...variants.host, ...variants.sandbox].flatMap(entry => [entry.path, entry.real,
    ...roots.flatMap(root => ['1', '8', '6'].flatMap(section => ['', '.gz'].map(suffix => join(root, `man${section}`, `${entry.command}.${section}${suffix}`))))]));
  const packages = await systemDocumentation(options.systemPackageRoot ?? '/var/lib/dpkg', wanted);
  const documents = new Map<string, Promise<CliUsageMetadata>>();
  const describe = (entry: { command: string; path: string; real: string }) => {
    const key = `${entry.command}:${entry.real}`; const previous = documents.get(key); if (previous) return previous;
    const pending = (async (): Promise<CliUsageMetadata> => {
    const documentation = await npmDocumentation(entry.real) ?? await manDocumentation(entry.command, roots, manualBinding(entry, packages))
      ?? await homebrewDocumentation(entry.real) ?? packages.get(entry.real);
    return documentation ? { description: documentation.description,
      scenarios: [documentation.scope === 'package'
        ? '当任务需要用途摘要所列的能力时，可核对该命令；当前只有包级说明，具体子命令和参数仍需核实。'
        : '当任务的输入和目标符合用途说明时，选择本命令；按所引资料核对参数和前提，以取得说明中的结果。'],
      documentation: { state: 'documented' as const, source: documentation.source, reference: documentation.reference,
        ...(documentation.scope ? { scope: documentation.scope } : {}) } }
      : { description: '已在有效 PATH 发现可执行命令；用途资料未知。',
        scenarios: ['适用场景未知；先取得具体用法说明，再决定调用。'],
        documentation: { state: 'unknown' as const, source: 'path' as const, reference: entry.command } };
    })(); documents.set(key, pending); return pending;
  };
  const grouped = new Map<string, { execution: 'host' | 'sandbox'; path: string; real: string; command: string }[]>();
  for (const execution of ['host', 'sandbox'] as const) for (const entry of variants[execution]) {
    const group = grouped.get(entry.command) ?? []; group.push({ ...entry, execution }); grouped.set(entry.command, group);
  }
  return concurrently([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')), async ([command, entries]) => {
    const base = await describe(entries[0]!);
    const discovery = await Promise.all(entries.map(async entry => {
      const usage = await describe(entry);
      return { execution: entry.execution, path: entry.real, ...(JSON.stringify(usage) === JSON.stringify(base) ? {} : { usage }) };
    }));
    return { command, ...base, discovery };
  });
}
