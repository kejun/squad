import { assertEvent, assign, setup } from 'xstate';

type ProcessSettlement =
  | { kind: 'closed'; exitCode: number | null; signal: string | null }
  | { kind: 'unconfirmed' };

type Context = {
  settlement: ProcessSettlement | null;
  cancellation: 'abort' | 'timeout' | null;
  processError: boolean;
  processRecorded: boolean;
};

type Event =
  | { type: 'process.opened' }
  | { type: 'process.closed'; exitCode: number | null; signal: string | null }
  | { type: 'process.error' }
  | { type: 'process.aborted' }
  | { type: 'process.timedOut' }
  | { type: 'process.hardDeadline' }
  | { type: 'identity.recorded' }
  | { type: 'identity.skipped' }
  | { type: 'identity.failed' }
  | { type: 'cleanup.groupKillFailed' }
  | { type: 'io.finished' }
  | { type: 'io.failed' };

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

const source = 'kejun/squad@ab0406bcb2993d7edd9a3b5ccba2cd5b8e6a8b9c/src/local-cli.ts';

// Documentation model. The caller sends observed events from I/O and timer boundaries.
export const cliReceiptMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    output: {} as Output,
  },
  actions: {
    recordClose: assign(({ event }) => {
      assertEvent(event, 'process.closed');
      return {
        settlement: { kind: 'closed' as const, exitCode: event.exitCode, signal: event.signal },
      };
    }),
    recordUnconfirmed: assign({ settlement: { kind: 'unconfirmed' } as const }),
    recordAbort: assign({ cancellation: 'abort' as const }),
    recordTimeout: assign({ cancellation: 'timeout' as const }),
    recordProcessError: assign({ processError: true }),
    recordIdentity: assign({ processRecorded: true }),
    recordIdentityError: assign(({ context }) => ({
      processError: true,
      cancellation: context.cancellation ?? 'abort',
    })),
  },
}).createMachine({
  id: 'cliReceiptV5',
  initial: 'preparing',
  context: { settlement: null, cancellation: null, processError: false, processRecorded: false },
  // XState types done-state output as unknown. Both terminal nodes emit Output.
  output: ({ event }) => event.output as Output,
  states: {
    preparing: {
      meta: { label: '准备日志并启动', source: source + ':180–235' },
      on: {
        'process.opened': { target: 'active' },
        'io.failed': { target: 'ioFailed' },
      },
    },
    active: {
      type: 'parallel',
      on: {
        'process.error': { actions: ['recordProcessError'] },
      },
      states: {
        process: {
          initial: 'running',
          states: {
            running: {
              meta: { label: '等待进程关闭', source: source + ':227–247' },
              on: {
                'process.closed': { target: 'closed', actions: ['recordClose'] },
                'process.aborted': { target: 'cancelling', actions: ['recordAbort'] },
                'process.timedOut': { target: 'cancelling', actions: ['recordTimeout'] },
                'identity.failed': { target: 'cancelling' },
              },
            },
            cancelling: {
              meta: { label: '清理进程组', source: source + ':220–225' },
              on: {
                'process.closed': { target: 'closed', actions: ['recordClose'] },
                'process.timedOut': { actions: ['recordTimeout'] },
                'process.hardDeadline': { target: 'unconfirmed', actions: ['recordUnconfirmed'] },
              },
            },
            closed: {
              type: 'final',
              meta: { label: '已收到 close', source: source + ':242–247' },
            },
            unconfirmed: {
              type: 'final',
              meta: { label: '关闭未确认', source: source + ':222–224' },
            },
          },
        },
        identity: {
          initial: 'pending',
          states: {
            pending: {
              meta: { label: '读取身份并等待日志写入', source: source + ':250–255' },
              on: {
                'identity.recorded': { target: 'finished', actions: ['recordIdentity'] },
                'identity.skipped': { target: 'finished' },
                'identity.failed': { target: 'finished', actions: ['recordIdentityError'] },
              },
            },
            finished: { type: 'final', meta: { label: '身份处理结束' } },
          },
        },
      },
      onDone: { target: 'finalizing' },
    },
    finalizing: {
      meta: { label: '整理回执与清理日志', source: source + ':257–271' },
      on: {
        'cleanup.groupKillFailed': { actions: ['recordProcessError'] },
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
