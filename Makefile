.PHONY: up down reset logs test test-db test-db-stop partner-demo

up:
	docker compose up --build

down:
	docker compose down

reset:
	docker compose down -v
	docker compose up --build

logs:
	docker compose logs -f backend

# Unit + e2e tests in containers, against a disposable database.
test:
	docker compose --profile test run --rm --build backend-test
	docker compose --profile test down -v

# Disposable Postgres on port 55432 for running `npm run test:e2e` from backend/ without Docker for Node.
test-db:
	docker run -d --rm --name paypoint-test-db -e POSTGRES_DB=paypoint_test -e POSTGRES_USER=paypoint \
		-e POSTGRES_PASSWORD=paypoint_test -p 55432:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine

test-db-stop:
	docker stop paypoint-test-db

# Calls the partner API with a signed request (needs `make up` running).
partner-demo:
	set -a; . ./.env; set +a; PARTNER_SECRET=$$DEMO_PARTNER_SECRET node scripts/partner-client.mjs
