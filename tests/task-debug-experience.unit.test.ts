import { describe, it } from 'vitest';
import { finishDiscussionWithoutOwner, verifyDiagnosticPaths, verifyDiscussionWait,
  verifyExpiredAndBudget, verifyPreviewAndHead, verifyRetryAndEmpty } from './task-debug-behavior.js';

describe('current-run diagnostic behavior', () => {
  it('[BT_V16] records the actual diagnostic path without changing the transition result', verifyDiagnosticPaths);
  it('[BT_V17] distinguishes short-circuit and no-op from rejection', verifyRetryAndEmpty);
  it('[BT_V18] previews without advancing and appends from the execution head', verifyPreviewAndHead);
  it('[BT_V24] distinguishes a ready discussion from unfinished owner work', () => verifyDiscussionWait(finishDiscussionWithoutOwner()));
  it('[BT_V25] invalidates stale previews and preserves budget rejection', verifyExpiredAndBudget);
});
