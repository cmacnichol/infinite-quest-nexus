# Rebuild Chronicle memory

Select **Rebuild memory** to recreate derived Chronicle records from the authoritative accepted-turn ledger.

Rebuild is a durable worker job. It can continue after the management page closes and is safe to claim across worker replicas. Story generation can continue with available lexical data while optional vector work is incomplete.

Use rebuild after an import, migration, or diagnosed derived-index inconsistency. It does not edit accepted narration, campaign state, private mechanics, or world canon.
