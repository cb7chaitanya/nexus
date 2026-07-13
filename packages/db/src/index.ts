// Foundation layer only. `@prisma/client` cannot be generated yet —
// `prisma generate` hard-fails on a schema with zero models ("You don't
// have any models defined ... so nothing will be generated"), and this
// package is deliberately model-less for now (see
// docs/implementation-plan.md, "Do NOT add: Prisma models").
//
// The pgvector/datasource wiring in prisma/schema.prisma is real and is
// verified directly against Postgres (see README / docker-compose), not
// through client generation, which is not possible until the first model
// lands.
//
// Once the first model exists, this file becomes the PrismaClient
// singleton export (cached on `globalThis` so dev hot-reload doesn't leak
// connections) that apps/api and apps/worker import.

export {};
