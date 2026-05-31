import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}
const protocol = new URL(connectionString).protocol;
if (protocol !== "postgres:" && protocol !== "postgresql:") {
  throw new Error(`DATABASE_URL must be PostgreSQL-compatible for this repo. Received ${protocol}`);
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
