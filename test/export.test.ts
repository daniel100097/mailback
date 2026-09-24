import { describe, expect, test } from "bun:test";
import { mboxEntry, mboxFromLine, UniqueNames } from "@/lib/export";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("mbox", () => {
  test("separator line uses asctime format in UTC", () => {
    expect(mboxFromLine(new Date("2026-09-03T08:05:09Z"))).toBe("From MAILER-DAEMON Thu Sep  3 08:05:09 2026\n");
    expect(mboxFromLine(new Date("2026-12-24T23:00:00Z"))).toBe("From MAILER-DAEMON Thu Dec 24 23:00:00 2026\n");
    expect(mboxFromLine(null)).toBe("From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n");
  });

  test("converts CRLF, quotes From lines (mboxrd) and ends with a blank line", () => {
    const source = "Subject: Hi\r\n\r\nFrom here on\r\n>From quoted\r\nnot From \r\n>>From x\r\nFromage";
    expect(text(mboxEntry(bytes(source), new Date("2026-09-03T08:05:09Z")))).toBe(
      "From MAILER-DAEMON Thu Sep  3 08:05:09 2026\n" +
        "Subject: Hi\n\n>From here on\n>>From quoted\nnot From \n>>>From x\nFromage\n\n",
    );
  });

  test("keeps bare CR and binary bytes, doesn't double the final line break", () => {
    const source = new Uint8Array([0x41, 0x0d, 0x42, 0xff, 0x0d, 0x0a]);
    const entry = mboxEntry(source, null);
    expect([...entry.subarray(entry.length - 6)]).toEqual([0x41, 0x0d, 0x42, 0xff, 0x0a, 0x0a]);
  });

  test("worst case fits the buffer", () => {
    const source = bytes("From \n".repeat(1000));
    expect(text(mboxEntry(source, null))).toEndWith(">From \n".repeat(1000) + "\n");
  });
});

test("unique names within a folder", () => {
  const names = new UniqueNames();
  expect(["Hi", "hi", "Hi", "Other"].map(n => names.take(n))).toEqual(["Hi", "hi (2)", "Hi (3)", "Other"]);
});
