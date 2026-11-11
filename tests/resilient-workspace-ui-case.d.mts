export class ResilientWorkspaceUICase {
  constructor(id: string);
  open(): Promise<void>;
  additional(): Promise<void>;
  prepareDeletionConfirmation(): Promise<void>;
  verifyDeletionConfirmation(): Promise<void>;
  cancelDeletionConfirmation(): Promise<void>;
  verifyDeletionAfterServiceRestart(): Promise<void>;
  act(): Promise<void>;
  verify(): Promise<void>;
  close(): Promise<void>;
  markFailed(message?: string): void;
}
