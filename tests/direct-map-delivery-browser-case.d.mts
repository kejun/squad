export class DirectMapDeliveryBrowserCase {
  open(): Promise<void>;
  act(): Promise<void>;
  verify(): Promise<void>;
  markFailed(message?: string): void;
  close(): Promise<void>;
}
