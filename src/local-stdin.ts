import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LocalToolError, within } from './local-skills.js';
import { validCliStdin, type HostCommandPlan } from './local-operation.js';

export interface PreparedCliStdin {
  plan: NonNullable<HostCommandPlan['stdin']>;
  file: FileHandle;
}
const forbidden = (path: string) => path.split('/').some(part => part === '.home' || part === '.git'
  || part === '.env' || part.startsWith('.env.') || /\.sqlite(?:-|$)/.test(part));

/** Make a private, immutable-by-path byte snapshot. Only its open read descriptor survives preparation. */
export async function prepareCliStdin(workspace: string, input: { path: string }, dataRoot: string,
  signal: AbortSignal): Promise<PreparedCliStdin> {
  if (!validCliStdin(input) || isAbsolute(input.path) || forbidden(input.path)) throw new LocalToolError('CLI_STDIN_INVALID');
  const root = await realpath(workspace);
  const requested = resolve(root, input.path);
  if (!within(root, requested)) throw new LocalToolError('CLI_STDIN_PATH_ESCAPE');
  let source: FileHandle | undefined, output: FileHandle | undefined, snapshot: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    const path = await realpath(requested);
    if (!within(root, path)) throw new LocalToolError('CLI_STDIN_PATH_ESCAPE');
    if (forbidden(relative(root, path))) throw new LocalToolError('CLI_STDIN_INVALID');
    const expected = await lstat(path);
    if (!expected.isFile()) throw new LocalToolError('CLI_STDIN_INVALID');
    source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await source.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
      || !within(root, await realpath(requested))) throw new LocalToolError('CLI_STDIN_PATH_ESCAPE');
    const directory = join(dataRoot, 'stdin');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `${randomUUID()}.input`);
    output = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of source.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted(); hash.update(chunk); bytes += chunk.length;
      await output.writeFile(chunk);
    }
    signal.throwIfAborted();
    const after = await source.stat();
    if (actual.size !== after.size || actual.mtimeMs !== after.mtimeMs || actual.ctimeMs !== after.ctimeMs)
      throw new LocalToolError('CLI_STDIN_CHANGED');
    await output.close(); output = undefined;
    snapshot = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    await unlink(temporary); temporary = undefined;
    return { file: snapshot, plan: { path: input.path, sha256: hash.digest('hex'), bytes } };
  } catch (error) {
    await snapshot?.close(); signal.throwIfAborted();
    if (error instanceof LocalToolError) throw error;
    throw new LocalToolError('CLI_STDIN_INVALID');
  } finally {
    await source?.close(); await output?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
