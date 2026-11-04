import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessIdentity } from './local-cli.js';

const execute = promisify(execFile);
// Host-only probe, never a model command. ABI: Apple's sys/proc_info.h proc_bsdinfo.
// Keep this inline so both the TypeScript entry and compiled distribution use it.
const probe = String.raw`
import ctypes, errno, json, sys
class BSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in
        ('flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','reserved')] + [
        ('comm',ctypes.c_char*16),('name',ctypes.c_char*32),
        ('nfiles',ctypes.c_uint32),('pgid',ctypes.c_uint32),('jobc',ctypes.c_uint32),
        ('tdev',ctypes.c_uint32),('tpgid',ctypes.c_uint32),('nice',ctypes.c_int32),
        ('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]
libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pidinfo.argtypes = [ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int
pid = int(sys.argv[1])
info = BSDInfo()
size = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
if size != ctypes.sizeof(info):
    print(json.dumps({'state':'missing' if size == 0 and ctypes.get_errno() in (errno.ESRCH,errno.ENOENT) else 'unknown'}))
elif info.pid != pid or not info.start_sec or info.start_usec >= 1000000:
    print(json.dumps({'state':'unknown'}))
elif info.status == 5:
    print(json.dumps({'state':'missing'}))
else:
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.sysctlbyname.argtypes = [ctypes.c_char_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.c_size_t]
    boot = ctypes.create_string_buffer(128)
    length = ctypes.c_size_t(len(boot))
    if libc.sysctlbyname(b'kern.bootsessionuuid',boot,ctypes.byref(length),None,0) != 0:
        raise RuntimeError('boot identity unavailable')
    print(json.dumps({'state':'alive','bootId':boot.value.decode('ascii'),
        'startTime':str(info.start_sec)+':'+str(info.start_usec)}))
`;

export async function darwinProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error('Invalid process identity PID');
  let data: { state?: string; bootId?: string; startTime?: string };
  try {
    const { stdout } = await execute('/usr/bin/python3', ['-I', '-c', probe, String(pid)], {
      timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' },
    });
    data = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error('Native macOS process identity unavailable'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  }
  if (data.state === 'missing') return null;
  if (data.state !== 'alive' || !/^[0-9a-f-]{36}$/i.test(data.bootId ?? '') || !/^\d+:\d{1,6}$/.test(data.startTime ?? ''))
    throw Object.assign(new Error('Native macOS process identity unknown'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  return { platform: 'darwin', pid, procPid: String(pid), pidNamespace: 'darwin', startTime: data.startTime!, bootId: data.bootId! };
}
