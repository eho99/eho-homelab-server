/**
 * Minimal structured logger. `docker compose logs -f plaid-sync` is the
 * intended way to read this, so every line is prefixed with a timestamp.
 */

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string, ...rest: unknown[]): void {
    console.log(`${ts()} INFO  ${msg}`, ...rest);
  },
  warn(msg: string, ...rest: unknown[]): void {
    console.warn(`${ts()} WARN  ${msg}`, ...rest);
  },
  error(msg: string, ...rest: unknown[]): void {
    console.error(`${ts()} ERROR ${msg}`, ...rest);
  },
};