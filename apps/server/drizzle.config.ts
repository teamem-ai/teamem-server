import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // DATABASE_URL is only needed for push/migrate against a live database;
  // `drizzle-kit generate` runs offline.
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/teamem',
  },
});
