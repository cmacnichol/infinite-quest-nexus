# Installation

Choose the deployment mode that matches the environment:

- [Docker Compose](./docker-compose.md) runs the application and PostgreSQL as a two-container local stack.
- [Docker Swarm](../operations/swarm/architecture.md) runs replicated API and worker services against external PostgreSQL and shared asset storage.
- Source development uses Node.js and pnpm and is not the recommended production deployment.

Before installing, review [requirements](./requirements.md), [network access](./network-access.md), and the current pre-authentication [security posture](../operations/security.md).
