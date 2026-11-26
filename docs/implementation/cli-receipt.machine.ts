import { createMachine, types } from 'xstate';

type CloseResult = { exitCode: number | null; signal: string | null };
type ProcessSettlement =
  | ({ kind: 'closed' } & CloseResult)
  | { kind: 'unconfirmed' };

type Context = {
  settlement: ProcessSettlement | null;
  cancellation: 'abort' | 'timeout' | null;
  processError: boolean;
  processRecorded: boolean;
};

type Completion = {
  ok: boolean;
  code: 'CLI_NOT_FOUND' | 'timeout' | 'cancelled' | 'succeeded' | 'failed' | 'CLI_SESSION_UNCERTAIN';
  exitCode: number | null;
  signal: string | null;
  settled: boolean;
  effectsKnown: boolean;
  processRecorded: boolean;
};

type Output =
  | { kind: 'returned'; completion: Completion }
  | { kind: 'ioFailed' };

function completion(context: Context): Completion {
  const closed = context.settlement?.kind === 'closed' ? context.settlement : null;
  const ok = closed?.exitCode === 0 && !context.processError && context.cancellation === null;
  const code = !closed ? 'CLI_SESSION_UNCERTAIN'
    : context.processError ? 'CLI_NOT_FOUND'
    : context.cancellation === 'timeout' ? 'timeout'
    : context.cancellation === 'abort' ? 'cancelled'
    : ok ? 'succeeded' : 'failed';

  return {
    ok,
    code,
    exitCode: closed?.exitCode ?? null,
    signal: closed?.signal ?? null,
    settled: closed !== null,
    effectsKnown: closed !== null && context.cancellation === null,
    processRecorded: context.processRecorded,
  };
}

const source = 'src/local-cli.ts';
const close = ({ event: { exitCode, signal } }: { event: CloseResult }) => ({
  target: 'closed' as const,
  context: { settlement: { kind: 'closed' as const, exitCode, signal } },
});

// Documentation model. The caller sends observed events from I/O and timer boundaries.
export const cliReceiptMachine = createMachine({
  schemas: {
    context: types<Context>(),
    events: {
      'process.opened': types<{}>(),
      'process.closed': types<CloseResult>(),
      'process.error': types<{}>(),
      'process.aborted': types<{}>(),
      'process.timedOut': types<{}>(),
      'process.hardDeadline': types<{}>(),
      'identity.recorded': types<{}>(),
      'identity.skipped': types<{}>(),
      'identity.failed': types<{}>(),
      'cleanup.groupKillFailed': types<{}>(),
      'io.finished': types<{}>(),
      'io.failed': types<{}>(),
    },
    output: types<Output>(),
    meta: types<{ label: string; source?: string }>(),
  },
  id: 'cliReceiptV5',
  initial: 'preparing',
  context: { settlement: null, cancellation: null, processError: false, processRecorded: false },
  states: {
    preparing: {
      meta: { label: '准备日志并启动', source: source + ':180–249' },
      on: {
        'process.opened': { target: 'active' },
        'io.failed': { target: 'ioFailed' },
      },
    },
    active: {
      type: 'parallel',
      on: {
        'process.error': () => ({ context: { processError: true } }),
        'cleanup.groupKillFailed': () => ({ context: { processError: true } }),
      },
      states: {
        process: {
          initial: 'running',
          states: {
            running: {
              meta: { label: '等待进程关闭', source: source + ':231–259' },
              on: {
                'process.closed': close,
                'process.aborted': () => ({ target: 'cancelling', context: { cancellation: 'abort' as const } }),
                'process.timedOut': () => ({ target: 'cancelling', context: { cancellation: 'timeout' as const } }),
                'identity.failed': { target: 'cancelling' },
              },
            },
            cancelling: {
              meta: { label: '清理进程组', source: source + ':221–229' },
              on: {
                'process.closed': close,
                'process.timedOut': () => ({ context: { cancellation: 'timeout' as const } }),
                'process.hardDeadline': () => ({ target: 'unconfirmed', context: { settlement: { kind: 'unconfirmed' as const } } }),
              },
            },
            closed: {
              type: 'final',
              meta: { label: '已收到 close', source: source + ':239–259' },
            },
            unconfirmed: {
              type: 'final',
              meta: { label: '关闭未确认', source: source + ':226–229' },
            },
          },
        },
        identity: {
          initial: 'pending',
          states: {
            pending: {
              meta: { label: '读取身份并等待日志写入', source: source + ':262–267' },
              on: {
                'identity.recorded': () => ({ target: 'finished', context: { processRecorded: true } }),
                'identity.skipped': { target: 'finished' },
                'identity.failed': ({ context }) => ({
                  target: 'finished', context: { processError: true, cancellation: context.cancellation ?? ('abort' as const) },
                }),
              },
            },
            finished: { type: 'final', meta: { label: '身份处理结束' } },
          },
        },
      },
      onDone: { target: 'finalizing' },
    },
    finalizing: {
      meta: { label: '整理回执与清理日志', source: source + ':269–279' },
      on: {
        'io.finished': { target: 'returned' },
        'io.failed': { target: 'ioFailed' },
      },
    },
    returned: {
      type: 'final',
      output: ({ context }): Output => ({ kind: 'returned', completion: completion(context) }),
    },
    ioFailed: {
      type: 'final',
      output: (): Output => ({ kind: 'ioFailed' }),
    },
  },
});
