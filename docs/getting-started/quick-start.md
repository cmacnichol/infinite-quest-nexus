# Quick start

This tutorial starts the two-container local deployment and takes you to a ready Nexus management screen.

## Prerequisites

- Docker Desktop using Linux containers
- Docker Compose plugin
- At least 2 GB of available memory
- A reachable supported text endpoint when you are ready to generate a story

## 1. Create local configuration

From the repository root:

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace the example database password. Set `CREDENTIAL_ENCRYPTION_KEY` to a long random value before storing provider API keys. Losing or changing this key makes stored provider credentials unreadable.

## 2. Start Nexus

```powershell
docker compose up --build
```

The first startup downloads the PostgreSQL/pgvector image, builds the application, waits for the database, applies online migrations, and creates the credential-free initial owner.

Open `http://localhost:8080/health/ready`. A ready response confirms that PostgreSQL is reachable and the `vector` extension is installed. It does not test provider connectivity or generated-asset storage.

Open Nexus World Management at `http://localhost:8080/nexus/`.

## 3. Configure story text

1. Select **Providers**.
2. Select **New provider profile**.
3. Enter a **Profile name**.
4. Select the provider type and choose the **Story text** role.
5. Enter its **Base URL** and, when required, its API key.
6. Use the model picker to discover and select a **Default model**.
7. Review **Context window**, **Maximum output**, **Temperature**, and **Request timeout (minutes)**.
8. Leave **Profile enabled** selected and, for the first text profile, select **Make this the default profile for its role**.
9. Select **Save provider**.

For LM Studio running on the Docker Desktop host, the usual base URL is `http://host.docker.internal:1234`. That hostname is a Docker Desktop convenience and must not be assumed in Swarm.

## 4. Verify the next step

Return to **Worlds**. The **World Library** area should let you enter a new world title.

Continue with [Create your first world](./first-world.md).

## Stop without deleting data

```powershell
docker compose down
```

This preserves both named volumes.

::: danger Permanent local reset
`docker compose down --volumes` removes the PostgreSQL and generated-asset volumes. Do not run it unless you intend to erase the local installation or have verified backups.
:::
