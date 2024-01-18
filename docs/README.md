# Warehouse Freshness Auditor documentation

The design, the input and output contracts, the limits and the verification
command are documented in [the README](../README.md), which is the single place
they are kept so the two cannot drift apart.

Three notes that belong beside the code rather than in the README:

## Why the clock is an argument

A freshness verdict is a comparison between a timestamp in a document and the
present. If the tool supplies the second operand itself, the verdict cannot be
reproduced, cannot be put in a test, and changes meaning when a job is retried
an hour later. So `--now` is required, `Date.now()` appears nowhere, and
`Date.parse` appears nowhere either — the latter because it reads
`2026-09-18T09:00:00` as local time and `2026-09-18` as UTC, which would make
the same document give different answers on two machines.

The consequence worth knowing: this tool cannot tell you whether your warehouse
is fresh *now*. It tells you whether the snapshot you exported describes a
warehouse that was fresh at the instant you named. Those differ, which is why
`limits.maxSnapshotAgeMinutes` exists — a snapshot older than that is refused
rather than treated as the present.

## Why a suspended table is not an incomplete run

The four unknown answers — absent history, a table missing from the snapshot, a
snapshot that disagrees with itself, a refresh dated after `--now` — are gaps in
evidence. The run wanted an answer and the documents did not contain one.

A suspended table is different. The policy was asked and it answered: this
table's deadline is not in force at this instant. That is a complete answer, so
it does not make the report `incomplete`.

The risk is that a reader sees `status: "pass"` and concludes the warehouse is
fresh. That is why a run which compared **no** table against a deadline emits
`no-deadline-in-force` as well, and why `summary.checked` and
`summary.suspended` are separate numbers. A pass over nothing is visible rather
than implied.

## Why a late table can exit 2

`table-late` is a verdict. `cause-undetermined` is the statement that the second
question — why — has no answer this run can support.

The alternative was to report the lateness alone and let a reader infer that
nothing upstream was at fault. That inference is exactly the positive claim the
evidence does not license: an upstream missing from the snapshot, or one the
policy declares no deadline for, might be the whole story. So both findings are
emitted, the second is in the evidence-missing list, and the exit code is 2.

Governing the upstream tables in the policy is what settles it. When every
upstream has a deadline, the chain is walked, the far end is named, and the run
exits 1 with `table-late-upstream`.
