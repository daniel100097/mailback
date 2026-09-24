import { ImapFlow } from "imapflow";

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export function createImapClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

/** Turn imapflow's errors into something readable for the UI. */
export function describeImapError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
  if (e.authenticationFailed) return "Authentication failed: check username and password";
  if (e.code === "ENOTFOUND") return "Host not found";
  if (e.code === "ECONNREFUSED") return "Connection refused";
  if (e.code === "ETIMEDOUT" || e.code === "CONNECT_TIMEOUT" || e.code === "GREETING_TIMEOUT") return "Connection timed out";
  return e.responseText ?? e.message;
}

/** Connect and log in, then disconnect. Throws a readable error message on failure. */
export async function testImapConnection(config: ImapConfig): Promise<void> {
  const client = createImapClient(config);
  // Connection errors are also emitted as events; without a listener they would crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.logout();
  } catch (error) {
    client.close();
    throw new Error(describeImapError(error));
  }
}
