#!/usr/bin/env python3
"""Own one test app and reap only its descendants, including orphaned probes."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import time

expected_parent = int(sys.argv[1])
if os.getppid() != expected_parent:
    raise RuntimeError('Verification owner exited before app launch')
subreaper = sys.platform.startswith('linux')
if subreaper:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'Unable to own orphaned app descendants')
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'Unable to monitor verification owner')

app = None
shutdown_at = None
reason = None

def emit(value):
    try:
        print('SQUAD_BROWSER_APP ' + json.dumps(value), flush=True)
    except BrokenPipeError:
        # An abruptly lost verification owner must still trigger bounded cleanup.
        request_cleanup(signal.SIGTERM)
        with open(os.devnull, 'w', encoding='utf8') as sink:
            os.dup2(sink.fileno(), sys.stdout.fileno())

def signal_app(signum):
    if app is not None:
        try:
            os.killpg(app.pid, signum)
        except ProcessLookupError:
            pass

def request_cleanup(signum, _frame=None):
    global shutdown_at, reason
    shutdown_at = shutdown_at or time.monotonic()
    reason = reason or ('owner-signal-' + str(signum))
    signal_app(signum)

signal.signal(signal.SIGTERM, request_cleanup)
signal.signal(signal.SIGINT, request_cleanup)
if os.getppid() != expected_parent:
    raise RuntimeError('Verification owner exited before app launch')
app = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, start_new_session=True)
app_group = os.getpgid(app.pid)
if app_group != app.pid:
    request_cleanup(signal.SIGKILL)
    raise RuntimeError('Node app did not receive its own process group')
emit({'phase': 'spawned', 'appPid': app.pid, 'processGroup': app_group,
      'supervisorPid': os.getpid(), 'supervisorProcessGroup': os.getpgrp(), 'subreaper': subreaper})
reaped = []
app_exit = None
while True:
    if os.getppid() != expected_parent and shutdown_at is None:
        reason = 'verification-owner-exited'
        request_cleanup(signal.SIGTERM)
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    except InterruptedError:
        continue
    if pid:
        reaped.append(pid)
        if pid == app.pid:
            code = os.waitstatus_to_exitcode(status)
            app_exit = {'code': code if code >= 0 else None,
                        'signal': signal.Signals(-code).name if code < 0 else None}
            shutdown_at = shutdown_at or time.monotonic()
            reason = reason or 'app-exited'
            signal_app(signal.SIGKILL)
        continue
    if shutdown_at is not None and time.monotonic() - shutdown_at > 2:
        signal_app(signal.SIGKILL)
        # Only adopted/direct children of this dedicated supervisor are eligible.
        # This bounded fallback handles a test descendant that made a new session.
        if subreaper:
            for entry in os.scandir('/proc'):
                if not entry.name.isdigit():
                    continue
                try:
                    with open(entry.path + '/stat', encoding='utf8') as stat_file:
                        stat = stat_file.read()
                    fields = stat[stat.rfind(')') + 2:].split()
                    if int(fields[1]) == os.getpid():
                        os.kill(int(entry.name), signal.SIGKILL)
                except (FileNotFoundError, ProcessLookupError):
                    pass
        if time.monotonic() - shutdown_at > 7:
            raise RuntimeError('Owned app descendants did not exit within cleanup deadline')
    time.sleep(0.02)
if app_exit is None:
    raise RuntimeError('No actual Node app exit was reaped')
emit({'phase': 'reaped', 'appPid': app.pid, 'processGroup': app_group,
      'supervisorPid': os.getpid(), 'supervisorProcessGroup': os.getpgrp(), 'subreaper': subreaper, 'appExit': app_exit,
      'reapedPids': reaped, 'reapedAll': True, 'cleanupReason': reason})
