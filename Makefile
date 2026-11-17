.PHONY: install migrate seed dev build test-api test-web e2e lint check docker

install:            ## Install server and frontend dependencies
	cd server && npm install
	cd frontend && npm install

migrate:            ## Apply database migrations (PostgreSQL, DATABASE_URL in server/.env)
	cd server && npm run migrate

seed:               ## Rebuild the local database with demo data
	cd server && npm run seed:reset

build:              ## Production build of the web app (frontend/dist) and the server (server/dist)
	cd frontend && npm run build
	cd server && npm run build

dev: build          ## Run the app on http://localhost:8000 (rebuild the UI with `npm run dev` in frontend/)
	cd server && npm run dev

test-api:           ## Server integration tests (needs TEST_DATABASE_URL)
	cd server && npm test

test-web:           ## Frontend unit tests
	cd frontend && npm test

e2e: build          ## Browser journeys against a freshly seeded server
	./e2e/run.sh

lint:               ## Static checks
	cd server && npm run typecheck
	cd frontend && npm run typecheck

check: lint test-api test-web e2e   ## Everything CI runs

docker:             ## Build the production image
	docker build -t partpilot:latest .
