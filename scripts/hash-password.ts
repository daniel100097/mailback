/**
 * Create a MAILBACK_PASSWORD_HASH for the login: `bun run hash-password [password]`.
 * Without an argument, the password is read from stdin (piped) or prompted for.
 */
const password = process.argv[2] ?? (process.stdin.isTTY ? prompt("Password:") : (await Bun.stdin.text()).replace(/\r?\n$/, ""));
if (!password) {
  console.error("No password given.");
  process.exit(1);
}
const hash = await Bun.password.hash(password, { algorithm: "argon2id" });

console.log(`
Add this to .env or your container environment:

MAILBACK_PASSWORD_HASH=${Buffer.from(hash).toString("base64")}

The raw hash also works where \`$\` isn't expanded (e.g. \`docker run -e\`, but not .env files or compose.yaml):
${hash}`);
