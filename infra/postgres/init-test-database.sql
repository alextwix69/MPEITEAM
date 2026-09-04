CREATE USER komanda_api WITH PASSWORD 'komanda-api-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE USER komanda_worker WITH PASSWORD 'komanda-worker-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE komanda_test;
CREATE USER komanda_legal WITH PASSWORD 'komanda-legal-local';
CREATE DATABASE komanda_legal OWNER komanda_legal;
CREATE DATABASE komanda_legal_test OWNER komanda_legal;

REVOKE ALL ON DATABASE komanda FROM PUBLIC;
REVOKE ALL ON DATABASE komanda_test FROM PUBLIC;
REVOKE ALL ON DATABASE komanda_legal FROM PUBLIC;
REVOKE ALL ON DATABASE komanda_legal_test FROM PUBLIC;
GRANT CONNECT ON DATABASE komanda TO komanda_api, komanda_worker;
GRANT CONNECT ON DATABASE komanda_test TO komanda_api, komanda_worker;
GRANT CONNECT ON DATABASE komanda_legal TO komanda_legal;
GRANT CONNECT ON DATABASE komanda_legal_test TO komanda_legal;

\connect komanda
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS profiles;
CREATE SCHEMA IF NOT EXISTS platform;
GRANT USAGE ON SCHEMA identity, profiles, platform TO komanda_api, komanda_worker;
ALTER DEFAULT PRIVILEGES FOR USER komanda_admin IN SCHEMA identity, profiles, platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO komanda_api, komanda_worker;
ALTER DEFAULT PRIVILEGES FOR USER komanda_admin IN SCHEMA identity, profiles, platform
  GRANT USAGE ON TYPES TO komanda_api, komanda_worker;

\connect komanda_test
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS profiles;
CREATE SCHEMA IF NOT EXISTS platform;
GRANT USAGE ON SCHEMA identity, profiles, platform TO komanda_api, komanda_worker;
ALTER DEFAULT PRIVILEGES FOR USER komanda_admin IN SCHEMA identity, profiles, platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO komanda_api, komanda_worker;
ALTER DEFAULT PRIVILEGES FOR USER komanda_admin IN SCHEMA identity, profiles, platform
  GRANT USAGE ON TYPES TO komanda_api, komanda_worker;
