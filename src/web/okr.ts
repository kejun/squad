import { z } from 'zod';
import type { RoomData } from '../store.js';
import { keyResultStatuses, type OkrLink } from '../types.js';

export const okrId = z.string().min(1).max(120);
const title = z.string().trim().min(1).max(200);
export const okrChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('objective'), id: okrId, title }),
  z.strictObject({ action: z.literal('keyResult'), id: okrId, objectiveId: okrId, title }),
  z.strictObject({ action: z.literal('status'), id: okrId, keyResultId: okrId, status: z.enum(keyResultStatuses) }),
]);
export type OkrChange = z.infer<typeof okrChange>;

function findResult(room: RoomData, keyResultId: string) {
  for (const objective of room.objectives ?? []) {
    const result = objective.keyResults.find(item => item.id === keyResultId);
    if (result) return { objective, result };
  }
}

export function linkOkr(room: RoomData, keyResultId: string): OkrLink | undefined {
  const found = findResult(room, keyResultId);
  if (found) return { keyResultId, objective: found.objective.title, keyResult: found.result.title };
}

export function applyOkrChange(room: RoomData, change: OkrChange): boolean {
  switch (change.action) {
    case 'objective':
      (room.objectives ??= []).push({ id: change.id, title: change.title, keyResults: [] });
      return true;
    case 'keyResult': {
      const objective = room.objectives?.find(item => item.id === change.objectiveId);
      if (!objective) return false;
      objective.keyResults.push({ id: change.id, title: change.title, status: 'pending' });
      return true;
    }
    case 'status': {
      const found = findResult(room, change.keyResultId);
      if (!found) return false;
      found.result.status = change.status;
      return true;
    }
  }
}
