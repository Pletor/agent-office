# Harness resource identity and registry

The catalog gives files an `el:<namespace>:<path hash>` identity. Moving a checkout preserves its canonical resource IDs. Editing content preserves the ID and changes the SHA-256 digest. Each persisted distinct digest gets an installation-local ordinal `version`; returning to a remembered digest returns its previous ordinal. The ordinal is informational, not evidence that a tool works. Use the full content digest for accepted snapshots and learning cohorts.

Project-relative paths deliberately share an ID across checkouts. Their actual content, source instance and missing state remain separate. Repository/task profile identity is still governed by the profile store; portable resource IDs do not move profiles automatically. Legacy absolute-path IDs remain aliases while that path is available. After a move, use the canonical ID; the old absolute-path alias is not reconstructed.

The server records metadata beside profiles in `<dataDir>/harness-registry.json`. Listings retain tombstones for vanished resources and never substitute another file for a missing assignment. The registry stores names, paths, digests and revision history, not file contents. Namespace visibility still applies: an ordinary worker cannot resolve private machine metadata. Registry failure leaves listing available but newly unpersisted versions are `0`.

The local CLI uses a registry only when explicitly configured:

```sh
office-harness --project /path/to/repo --data-dir /path/to/office-data
```

`AGENT_OFFICE_DATA_DIR` is the equivalent environment variable. Without either setting, the local CLI does not create an implicit personal registry. The running office API uses its configured data directory.

## Shared versus private resources

Set `AGENT_OFFICE_SHARED_HARNESS_DIR` to a deliberately public, reviewed folder. Its entries are visible to ordinary workers and administrators and may be assigned globally. The handbook is also global. Project files, administrator machine folders, `AGENT_OFFICE_HARNESS_DIR` and OpenViking source files remain restricted to repository/task assignments. Pinning an OpenViking folder does not publish its contents to all workers. Existing invalid global bindings produce a blocking handoff warning rather than selecting a same-path file from another project. None of these assignments grants execution permissions.

## Migration, recovery and rollback

Stop old registry writers before upgrading. Schema 1 is read without rewriting it until a changed listing needs to be recorded. Before the first schema-2 publication, its exact UTF-8 bytes are saved as `harness-registry.json.v1.<full SHA-256>.bak`; an existing backup is never replaced. Schema 2 has a store revision counter in addition to each resource's content ordinal. The old schema-1 reader refuses schema 2 rather than silently dropping the counter.

Each update publishes an exclusive `.rev.<number>.<base digest>` file. The lease reduces contention; exclusive publication prevents a displaced writer from overwriting the winner. Readers follow published successors when main-file replacement was interrupted, including a read-only main file on Windows. Up to ten recent published revisions are retained, with older successors needed to recover the main file kept as well. Filesystems without hard-link support refuse persistence; they do not fall back to an unsafe overwrite.

For rollback to an old registry implementation, stop all registry writers, preserve the entire data directory, restore the matching `.v1.*.bak` as `harness-registry.json`, and move this registry's `.rev.*` files out of the active directory. Otherwise replay would follow the restored base forward again. This rollback discards post-migration metadata; profiles and accepted snapshots must be preserved separately. Do not delete journals from a live instance. A damaged main file is left untouched; repair from preserved data before resuming writes.

Verification covers legacy-byte preservation, concurrent processes, displacement after the final lease check, recovery before main replacement, aliases, private metadata boundaries, bounded history, and explicit public sharing. It does not certify an underlying network filesystem's durability or make tool outcomes deterministic.
