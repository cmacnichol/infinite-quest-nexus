# Scale Swarm services

The example stack starts two API and two worker replicas.

```bash
docker service scale infinitequest_infinitequest-api=3
docker service scale infinitequest_infinitequest-worker=4
```

API replicas are stateless but consume PostgreSQL connections. Workers claim durable jobs with database locks and leases. Before scaling, calculate aggregate database pool limits, provider concurrency, model capacity, asset throughput, and queue latency.

Default resource limits are 1 CPU/1 GiB for API and 2 CPU/2 GiB for worker, with 0.25 CPU/256 MiB reservations. Measure workload before changing them.

No sticky sessions are required. Scaling workers cannot compensate for a provider that permits only one safe concurrent generation.
