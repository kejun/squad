export class ForceRoomDeletionBrowserCase {
  constructor(id: string);
  open(): Promise<this>;
  additional(): Promise<void>;
  act(): Promise<void>;
  verify(): Promise<void>;
  verifyDeletionAfterServiceRestart(): Promise<void>;
  markFailed(message?: string): void;
  close(): Promise<void>;
}
