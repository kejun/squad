export class WindowStdinUICase {
  constructor(id: string);
  open(): Promise<void>;
  closeAndReload(): Promise<void>;
  verifyExpired(): Promise<void>;
  authorizeWindow(): Promise<void>;
  verifyAuthorizedWindow(): Promise<void>;
  showApproval(): Promise<void>;
  verifyInputPlan(): Promise<void>;
  rejectInput(): Promise<void>;
  markFailed(message?: string): void;
  close(): Promise<void>;
}
