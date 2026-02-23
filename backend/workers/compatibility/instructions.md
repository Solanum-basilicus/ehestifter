# Compatibility Worker (local)

## Prereqs
1) Install Docker + Docker Compose plugin
2) Install Ollama on the host and ensure it listens on port 11434
   - Ollama API base is http://localhost:11434/api by default.

## Prepare repo
Option A: clone whole repo
- git clone <your repo>
- cd <repo>/backend/workers/compatibility

Option B (optional): sparse checkout just worker dir
- git clone --filter=blob:none --no-checkout <your repo>
- cd <repo>
- git sparse-checkout init --cone
- git sparse-checkout set backend/workers/compatibility
- git checkout main
- cd backend/workers/compatibility

## Configure
- cp .env.template .env
- cp config.yaml.template config.yaml
- edit .env and config.yaml

## Start
- docker compose up -d --build
- docker compose logs -f

## Update to latest code
- ./update.sh