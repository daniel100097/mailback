import { afterEach, expect, spyOn, test } from "bun:test";
import { ImapFlow } from "imapflow";
import { env } from "@/server/env";
import { createImapClient, ReadOnlyError } from "@/server/imap";

const config = { host: "imap.invalid", port: 993, secure: true, username: "u", password: "p" };

afterEach(() => {
  env.MAILBACK_READ_ONLY = false;
});

test("read-only clients reject every IMAP write", async () => {
  env.MAILBACK_READ_ONLY = true;
  const client = createImapClient(config);
  await expect(client.append("INBOX", "Subject: x\r\n\r\nx")).rejects.toBeInstanceOf(ReadOnlyError);
  await expect(client.messageFlagsAdd("1:*", ["\\Seen"])).rejects.toBeInstanceOf(ReadOnlyError);
  await expect(client.messageDelete("1:*")).rejects.toBeInstanceOf(ReadOnlyError);
  await expect(client.mailboxCreate("New")).rejects.toBeInstanceOf(ReadOnlyError);
});

test("read-only clients open folders with EXAMINE", async () => {
  const open = spyOn(ImapFlow.prototype, "mailboxOpen").mockResolvedValue({} as never);
  try {
    env.MAILBACK_READ_ONLY = true;
    await createImapClient(config).mailboxOpen("INBOX", { readOnly: false });
    expect(open).toHaveBeenLastCalledWith("INBOX", { readOnly: true });

    env.MAILBACK_READ_ONLY = false;
    await createImapClient(config).mailboxOpen("INBOX");
    expect(open).toHaveBeenLastCalledWith("INBOX");
  } finally {
    open.mockRestore();
  }
});
