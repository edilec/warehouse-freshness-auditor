# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface. Renaming or removing one is a
breaking change and is recorded here.

## [0.1.0] - 2026-09-19

### Added

- Per-table freshness verdicts from an exported snapshot and a declared policy,
  at an instant the caller supplies. `--now` is required and has no default:
  this tool reads no clock of its own, so two runs over the same documents
  produce byte-identical stdout.
- `refresh-history-absent`, `policy-table-absent`, `refresh-history-conflict`
  and `refresh-in-future`: four ways a table is neither fresh nor late, each
  reported as evidence the run did not obtain rather than as a verdict.
- Cause propagation through the snapshot's lineage edges: a late table names the
  chain to its far end, and only the table with no late upstream is blamed for
  itself.
- `cause-undetermined`: a table can be provably late while why it is late stays
  unsettled. The lateness is reported as established and the gap beside it,
  rather than the lateness being attributed to the table by default.
- Suspension by policy, for tables that opt in: non-business days from a
  declared working week, and half-open maintenance windows. A run where every
  deadline was suspended also emits `no-deadline-in-force`, so a pass cannot be
  read as "everything is fresh".
- A frozen `ruleId -> severity` table, and a separate list of rule ids that mean
  the run did not reach a verdict. Any one of those makes the report
  `incomplete` and the process exit `2`.
- Bounds on policy bytes, policy tables, maintenance windows, table deadline,
  calendar offset, identifier length, snapshot bytes, tables, runs, upstream
  edges, lineage depth and snapshot age, each enforced before the work it bounds
  and each tested from both sides.
