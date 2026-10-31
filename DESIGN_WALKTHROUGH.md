# AtomicTrail design walkthrough

## 90-second demo

1. **(15 s) Problem.** "Stores sell top-ups from a prepaid balance. The hard part is money correctness when requests race, retry or fail halfway."
2. **(25 s) Cashier view.** Sell to `3001230000`: the simulated carrier rejects it, the sale shows *Fallida*, and the ledger shows the SALE and its REFUND. Then a normal sale is confirmed with a provider reference.
3. **(20 s) Partner API.** `make partner-demo`: signed requests change the balance. "Change one byte of the body and the signature fails; replay it after five minutes and the timestamp fails."
4. **(30 s) Proof.** `docs/concurrency-experiment.md`: the naive version approves 70 of 70 and creates COP 126,000 out of nothing; PayPoint approves exactly 50. Then open the 70-way idempotency test in `test/e2e/sales.e2e-spec.ts`.

## Hard questions

**1. Two cashiers sell the last COP 3,000 at the same time. Walk me through it.**
Both run `UPDATE points_of_sale SET balance = balance - 3000 WHERE id = $1 AND balance >= 3000`. The first takes the row lock and commits. The second waits, then PostgreSQL re-evaluates the `WHERE` against the committed row, finds 0, updates nothing, and we return 409 `INSUFFICIENT_BALANCE`. Evidence: `sales.service.ts` `createSale`; test "stays consistent under 70 concurrent sales".

**2. Why not `SELECT … FOR UPDATE`?**
It is also correct, but it takes two round trips while holding the lock. The conditional `UPDATE` is correct in one statement. I measured the naive read-then-write: 70 approvals out of 70 instead of 50 (`docs/concurrency-experiment.md`).

**3. What exactly does the advisory lock do that `UNIQUE (pos_id, idempotency_key)` doesn't?**
The unique index alone makes the second concurrent request fail with a constraint error after it has already debited the balance, so it has to roll back and translate the error. `pg_advisory_xact_lock(hash(pos + key))` makes it wait for the first request; it then finds the sale and returns it with 200. The constraint stays as the last line of defense.

**4. The provider times out after you already debited. Refund?**
No. A timeout means the outcome is unknown, and the carrier may have delivered the top-up. The sale stays `PENDING` with the money reserved, and a reconciliation job (a known limitation, listed in the README) would ask the provider. Evidence: test "keeps the sale PENDING and does not refund".

**5. Why is the provider called outside the transaction?**
So the balance row lock isn't held during network I/O. Inside a transaction, a slow provider would serialize every sale of that store behind it. The cost is a two-step flow (reserve, then confirm or compensate), which is a small saga.

**6. How can a refund never happen twice?**
`UPDATE sales SET status='FAILED' WHERE id=$1 AND status='PENDING'` is a one-time transition, and `CREATE UNIQUE INDEX … ON balance_movements (sale_id) WHERE type='REFUND'` makes a second refund impossible even with a code bug.

**7. Walk me through the HMAC check. What does it not protect against?**
The client signs `timestamp \n METHOD \n path \n sha256(body)`, and we recompute it and compare with `timingSafeEqual`. It protects integrity, authenticity and replays older than 5 minutes; a replay inside the window is absorbed by idempotency. It does not protect a stolen secret, which is why the IP allowlist exists and why production secrets belong in KMS.

**8. How would this scale to 10 API instances?**
Unchanged. All locks and invariants live in PostgreSQL and the API is stateless. Migrations already take an advisory lock so replicas don't race. The next bottleneck would be hot rows (one very busy store), which could be handled with sharded sub-balances.

**9. What would you build next?**
Reconciliation of `PENDING` sales, idempotent admin credits, secrets in KMS, rate limiting on login, and an outbox for events.

**10. Did you use AI tools?**
Yes, as an engineering assistant (Claude Code), the way I'd use any tool. The design decisions, the review, and the verification through tests and the concurrency experiment are mine, and I can walk through any line.
