# Network access

## Browser to Nexus

Compose publishes the application on host port 8080 by default. No TLS proxy is included. Keep access local or on the intended trusted network and add an operator-managed TLS reverse proxy before remote use.

## Application to PostgreSQL

Compose uses service DNS name `postgres` on the private `infinitequest-backend` network. PostgreSQL is not host-published unless the development override is explicitly enabled.

## Worker to providers

Provider base URLs must be reachable from the application container in Compose and from every eligible worker node in Swarm. Browser reachability alone is insufficient.

Docker Desktop commonly exposes host services as `host.docker.internal`. Swarm does not guarantee this name; use stable private DNS.

## CORS

The runtime default allows all origins. This is not authentication or authorization. Set a reviewed `CORS_ALLOWED_ORIGINS` value in deployment modes that explicitly inject it, and enforce the trusted-network boundary independently.
