# Administrative closure with unknown provider outcome

`abandoned_unknown` means that a delivery crossed its durable transport frontier,
but provider acceptance or rejection cannot be established. It closes the attempt
without authorizing retransmission. It is not evidence of rejection or acceptance.

The internal `createEvolutionDelivery(...).reconcile` method requires:

```js
await delivery.reconcile(kind, deliveryId, tenantId, originalOperationToken, {
  stopped: true,
  outcome: 'abandoned_unknown',
  expectedInstance: verifiedInstanceName,
});
```

There is no public HTTP endpoint. `stopped: true` is a privileged, verified operator
attestation that the original execution has stopped, not a user assertion or a TTL.
In particular, a transport timeout is not sufficient. Verify the old request and
executor termination before invoking this API. Old executions predating this
change do not have an execution advisory lock. Database connection loss also
invalidates a session lock as proof of executor termination.

New deliveries retain a PostgreSQL session advisory lock until the actual callback
settles, even after the ownership deadline. Closure checks a nonblocking transaction
advisory lock and an in-process active execution registry. Guards use at most
`pool.max - 2` connections, preserving pool capacity for SQL progress; insufficient
capacity fails before transport and follows existing safe recovery. A permanently
unsettled callback retains its guard until executor termination; it is not recycled
by a background timer. No database transaction is held across transport.

Closure uses the official source-account then canonical-owner lock order and the
existing `acknowledgeStoppedOperation` transaction. It checks tenant, current owner,
instance, delivery ID, exact operation/claim tokens, `uncertain`, nonempty transport
intent, positive attempts and absent `sent_at`. It applies to both outbox messages
and appointment reminders. Other states and uncertainty before transport are denied.
An existing provider message ID in conversation response correlation also rejects
unknown closure: that evidence requires conclusive reconciliation instead.

The delivery becomes `failed`, with an explicit unknown/no-retry explanation.
Content, identity, attempt count, claim time and transport intent remain unchanged;
`sent_at` stays empty. The original operation and claim tokens remain in the durable
receipt, together with instance, tenant, delivery identity, outcome and timestamp.
The preceding `last_error` is retained as `previous_last_error` in that receipt.
The live claim/reservation are cleared only atomically with that receipt, through
the official ownership operation. No transport, new delivery or pending state is
created by reconciliation.

Repeating identical arguments returns idempotently, including a lost COMMIT
acknowledgement and concurrent processes, without clearing a later reservation.
Conflicting outcomes (`accepted`, `rejected`, `not_accepted`) are rejected after
this receipt, even through the legacy/null-token path. Conversely, this disposition
cannot replace an existing conclusive receipt. Later evidence can be recorded by a
separate audited investigation; this API does not rewrite the original disposition.

An expired conversation can subsequently receive a new inbound through its normal
flow, preserving captures, receipts, customer and appointments. Old event IDs remain
idempotent. Closure does not reopen expired inputs or replay the old response.

Migration 028 only adds a nullable instance column for existing receipts and expands
the receipt outcome constraint, requiring an instance for the new disposition.
It also adds the nullable previous-error field and a partial unique receipt index
for unknown closures, supporting checks across operation tokens.
It takes ACCESS EXCLUSIVE on the receipts table, scans receipts for validation,
and uses a two-second lock timeout. It does not scan/update the outbox or change old
migrations. Local transactional rollback is tested. A production downgrade must not
drop receipts: the old constraint cannot be restored while new-outcome receipts
exist. This change contains no automatic downgrade or production reconciliation.
