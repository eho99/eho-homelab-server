/**
 * Ambient types for the Plaid Link browser SDK, which ships as plain JS with
 * no declarations. Only the surface this project's tests and status page use
 * is described.
 */
interface PlaidLinkHandler {
  open(): void;
  exit(): void;
  destroy(): void;
}

interface PlaidLinkOptions {
  token: string;
  onSuccess?: (publicToken: string, metadata: Record<string, unknown>) => void;
  onExit?: (error: unknown, metadata: Record<string, unknown>) => void;
  onEvent?: (eventName: string, metadata: Record<string, unknown>) => void;
}

interface Window {
  Plaid: {
    create(config: PlaidLinkOptions): PlaidLinkHandler;
  };
}