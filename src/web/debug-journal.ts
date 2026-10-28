import { randomUUID } from 'node:crypto';
import type { DebugFrame, DebugRecord } from '../task-debug.js';

export class DebugJournal {
  readonly sessionId = randomUUID();
  private sequence = 0;
  private bytes = 0;
  private records: { record: DebugRecord; bytes: number }[] = [];
  constructor(private readonly maxRecords = 200, private readonly maxBytes = 4 * 1024 * 1024) {}
  append(roomId: string, frame: DebugFrame) {
    const snapshot = frame.snapshot as { context: { taskId: string } };
    const record: DebugRecord = { ...frame, roomId, taskId: snapshot.context.taskId, sequence: ++this.sequence };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    this.records.push({ record, bytes }); this.bytes += bytes;
    while (this.records.length && (this.records.length > this.maxRecords || this.bytes > this.maxBytes)) this.bytes -= this.records.shift()!.bytes;
  }
  read(roomId: string, after = 0, sessionId?: string) {
    const first = this.records[0]?.record.sequence ?? this.sequence + 1;
    const reset = !!sessionId && sessionId !== this.sessionId;
    return {
      sessionId: this.sessionId, cursor: this.sequence,
      truncated: reset || after > this.sequence || (after < first - 1),
      records: this.records.filter(({ record }) => record.roomId === roomId && (reset || record.sequence > after)).map(({ record }) => structuredClone(record)),
    };
  }
}

