// CLI: `bun run db:migrate`. The server also applies migrations on startup.
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { env } from "../env";
import { db, sqlite } from ".";

migrate(db, { migrationsFolder: env.MIGRATIONS_DIR });
console.log("✅ Migrations applied");
sqlite.close();
