-- Readiness probes read only migration status, never migration logs or write access.
GRANT SELECT (migration_name, finished_at, rolled_back_at)
  ON public._prisma_migrations TO komanda_api, komanda_worker;
