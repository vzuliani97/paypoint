# Concurrency experiment: why PayPoint debits with a conditional UPDATE

**Question:** what happens when many sales hit the same prepaid balance at the same moment?

**Setup:** 70 concurrent debits of COP 2,000 against a balance of COP 100,000. That leaves room for exactly 50 of them.

- PostgreSQL 16 (Docker, `postgres:16-alpine`), default `READ COMMITTED` isolation.
- `pg` connection pool of 10, so 10 transactions really run in parallel.
- MacBook (Apple Silicon), Node.js 24.
- Test: [`backend/test/e2e/concurrency-experiment.e2e-spec.ts`](../backend/test/e2e/concurrency-experiment.e2e-spec.ts)

| Variant | Code |
|---|---|
| **Naive** | `SELECT balance` → check in JavaScript → `UPDATE … SET balance = <computed value>`, with 10 ms of simulated work between read and write |
| **Safe** (what PayPoint does) | `UPDATE … SET balance = balance - $1 WHERE id = $2 AND balance >= $1` |

## Results (3 runs, identical each time)

| Variant | Debits approved | Final balance | Balance implied by approved debits | Money created |
|---|---|---|---|---|
| Naive | **70** | 86,000 | −40,000 | **COP 126,000** |
| Safe | **50** | 0 | 0 | 0 |

## Why the naive version fails

Several transactions read the same balance, for example 100,000. Each decides the debit fits, and each writes `100,000 − 2,000`. They overwrite each other: a **lost update**. Every debit was approved, so every product was handed out, but most of the money was never taken from the balance.

`READ COMMITTED` does not prevent this, because each transaction's `SELECT` sees a valid committed value. The bug lives in the gap between reading and writing.

## Why the safe version works

The check and the write are one statement. PostgreSQL locks the row while updating it. A concurrent `UPDATE` waits, then **re-evaluates `balance >= $1` against the new value** before writing. No interleaving can approve a debit the balance cannot cover, and `CHECK (balance >= 0)` on the table is a second safety net.

## Limits of this experiment

- The 10 ms pause widens the race window so it shows up every time. Without it the naive version still fails, just less often. That is worse in practice, because the bug then hides in testing.
- It is a local, single-node database; it does not measure throughput or latency under production load.
- Alternatives that also work: `SELECT … FOR UPDATE` (pessimistic locking), a `version` column (optimistic locking), or `SERIALIZABLE` isolation with retries. The conditional `UPDATE` was chosen because it is correct in a single round trip and needs no retry logic.

Reproduce it with `make test-db`, then `cd backend && npx jest --selectProjects e2e test/e2e/concurrency-experiment`.
