export class ModelServiceErrorBrowserCase {
  open(status: number): Promise<this>;
  act(choice: string): Promise<void>;
  verify(): Promise<void>;
  markFailed(message?: string): void;
  close(): Promise<void>;
}
