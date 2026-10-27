// Defaults for running e2e tests locally against the throwaway database from `make test-db`.
// docker-compose overrides DATABASE_URL when tests run in a container.
process.env.DATABASE_URL ??= 'postgres://paypoint:paypoint_test@localhost:55432/paypoint_test';
process.env.JWT_SECRET ??= 'e2e-test-secret-that-is-at-least-32-chars';
process.env.PROVIDER_TIMEOUT_MS ??= '300';
