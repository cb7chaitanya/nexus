import { PrismaClient } from "@prisma/client";

// This is the ONLY PrismaClient the running application uses, and it
// deliberately connects as APP_DATABASE_URL (raas_app), never
// DATABASE_URL (raas). raas is a Postgres superuser by default in the
// docker-compose image, and superusers bypass Row-Level Security
// unconditionally — regardless of FORCE ROW LEVEL SECURITY, regardless of
// table ownership. Connecting the app as a superuser would silently
// defeat every RLS policy in this schema. See docs/decisions.md for how
// this was found (empirically, not assumed) and infra/postgres/init.sql
// for where raas_app is created.
//
// DATABASE_URL (raas) is used ONLY by the Prisma CLI (migrate/generate),
// which legitimately needs DDL privileges raas_app does not have.
const appDatabaseUrl = process.env.APP_DATABASE_URL;

if (!appDatabaseUrl) {
  throw new Error(
    "APP_DATABASE_URL is not set. The application must connect as the " +
      "restricted raas_app role, not the DATABASE_URL superuser role — " +
      "see docs/decisions.md. Refusing to start rather than silently " +
      "falling back to a role that bypasses Row-Level Security.",
  );
}

// Cache on `globalThis` in dev so hot-reloading (tsx --watch, Next.js fast
// refresh) doesn't open a new connection pool on every reload.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: appDatabaseUrl });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
