import { collectionCoverage } from "@accountability/discovery-acquisition/collection";
import type { ScheduleSnapshot } from "@accountability/discovery-acquisition/scheduler";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  refKey,
  requireScope,
  validTime,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace } from "./index.ts";
import type {
  VisualNode,
  VisualEvent,
  WorkspaceSnapshot,
  WorkStage,
} from "./index.ts";
export type AcquisitionWindow = {
  itemOffset?: number;
  itemLimit?: number;
  attemptOffset?: number;
  attemptLimit?: number;
};
const json = (v: unknown): Json => JSON.parse(canonical(v)) as Json;
const reserved = [
  "acquisition-collection",
  "acquisition-item",
  "acquisition-attempt",
];
function reference(
  c: Context,
  kind: string,
  id: string,
  revision: number,
): Ref {
  return validateRef({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind,
    id,
    revision,
  });
}
function window(
  offset: number,
  limit: number,
  total: number,
  maximum: number,
): void {
  invariant(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= total &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= maximum,
    "invalid_window",
    "Acquisition history window is invalid",
  );
}
/** The host supplies an authenticated, authorized snapshot. No DB/network/mutation occurs here. */
export function projectAcquisition(
  c: Context,
  input: ScheduleSnapshot,
  stage: WorkStage,
  options: AcquisitionWindow = {},
): WorkspaceSnapshot {
  const { state, revision } = structuredClone(input),
    collection = state.collection;
  requireScope(c, collection);
  requireScope(c, collection.sourcePolicy);
  invariant(
    state.schemaVersion === 1 &&
      typeof state.enabled === "boolean" &&
      collection.items.length <= 1000 &&
      collection.attempts.length <= 10000,
    "invalid_acquisition_snapshot",
    "Invalid acquisition schema or history budget",
  );
  const root = reference(
    c,
    "acquisition-collection",
    digest({ collectionId: collection.id }),
    revision,
  );
  const items = new Map(collection.items.map((item) => [item.id, item])),
    attempts = new Map(
      collection.attempts.map((attempt) => [attempt.id, attempt]),
    );
  invariant(
    items.size === collection.items.length &&
      attempts.size === collection.attempts.length &&
      state.leases.length === collection.attempts.length,
    "invalid_acquisition_snapshot",
    "Duplicate or incomplete acquisition identities",
  );
  const leases = new Map<string, (typeof state.leases)[number]>();
  for (const lease of state.leases) {
    const attempt = attempts.get(lease.attemptId);
    invariant(
      attempt &&
        items.has(attempt.itemId) &&
        lease.itemId === attempt.itemId &&
        !leases.has(lease.attemptId),
      "invalid_acquisition_snapshot",
      "Lease must bind one exact known attempt and item",
    );
    invariant(
      ["leased", "running", "reconcile", "completed"].includes(lease.status) &&
        lease.leasedAt === attempt.startedAt &&
        validTime(lease.expiresAt) > validTime(lease.leasedAt),
      "invalid_acquisition_snapshot",
      "Invalid acquisition lease state or time",
    );
    nonempty(lease.actorId, "worker identity", 128);
    invariant(
      ["service", "agent"].includes(lease.actorKind),
      "invalid_acquisition_snapshot",
      "Unknown worker kind",
    );
    invariant(
      lease.status === "completed"
        ? ["captured", "unchanged", "failed"].includes(attempt.status)
        : attempt.status === "started",
      "invalid_acquisition_snapshot",
      "Attempt and lease completion states differ",
    );
    if (lease.receipt) {
      validateRef(lease.receipt);
      requireScope(c, lease.receipt);
      invariant(
        !reserved.includes(lease.receipt.kind),
        "reference_collision",
        "Receipt uses reserved acquisition projection kind",
      );
    }
    if (lease.status !== "completed")
      invariant(
        lease.receipt === null &&
          attempt.completedAt === null &&
          attempt.sha256 === null &&
          attempt.receiptId === null &&
          attempt.failureCode === null,
        "invalid_acquisition_snapshot",
        "Pending work cannot carry a completed outcome",
      );
    if (attempt.status === "failed")
      invariant(
        attempt.sha256 === null &&
          attempt.receiptId === null &&
          /^[a-z0-9_]{1,64}$/.test(attempt.failureCode ?? "") &&
          (lease.receipt !== null ||
            attempt.failureCode === "lease_expired_unconsumed"),
        "invalid_acquisition_snapshot",
        "Failure lacks verified outcome or safe unconsumed expiration",
      );
    if (attempt.status === "captured" || attempt.status === "unchanged")
      invariant(
        lease.receipt &&
          attempt.receiptId === lease.receipt.id &&
          /^[a-f0-9]{64}$/.test(attempt.sha256 ?? ""),
        "invalid_acquisition_snapshot",
        "Capture lacks its exact outcome receipt or digest",
      );
    if (lease.status === "completed")
      invariant(
        attempt.completedAt !== null &&
          validTime(attempt.completedAt) >= validTime(attempt.startedAt),
        "invalid_acquisition_snapshot",
        "Completion time is missing or precedes the attempt",
      );
    leases.set(lease.attemptId, lease);
  }
  const itemOffset = options.itemOffset ?? 0,
    itemLimit = options.itemLimit ?? 50,
    attemptOffset = options.attemptOffset ?? 0,
    attemptLimit = options.attemptLimit ?? 100;
  window(itemOffset, itemLimit, collection.items.length, 100);
  window(attemptOffset, attemptLimit, collection.attempts.length, 200);
  const visibleAttempts = collection.attempts.slice(
    attemptOffset,
    attemptOffset + attemptLimit,
  );
  const selected = new Set(
    collection.items
      .slice(itemOffset, itemOffset + itemLimit)
      .map((item) => item.id),
  );
  for (const attempt of visibleAttempts) selected.add(attempt.itemId);
  const coverage = collectionCoverage(c, collection),
    uncertain = state.leases.filter(
      (l) => l.status === "running" || l.status === "reconcile",
    ).length;
  const nodes: VisualNode[] = [
    {
      ref: root,
      label: "Acquisition " + collection.id,
      kind: "objective",
      state: !state.enabled
        ? "paused"
        : uncertain
          ? "enabled-with-unresolved-work"
          : "enabled",
      stage,
      dependencies: [],
      summary: `${coverage.capturedItems} of ${coverage.expected} planned items captured; ${coverage.uniqueByteEditions} unique byte editions. Capture counts are not incident counts.`,
      details: json({
        collectionId: collection.id,
        storageRevision: revision,
        coverage,
        unresolvedConsumedAttempts: uncertain,
        sourcePolicy: {
          id: collection.sourcePolicy.id,
          enabled: collection.sourcePolicy.enabled,
          expiresAt: collection.sourcePolicy.expiresAt,
        },
        windows: {
          itemOffset,
          itemLimit,
          attemptOffset,
          attemptLimit,
          displayedItems: selected.size,
          displayedAttempts: visibleAttempts.length,
          totalItems: collection.items.length,
          totalAttempts: collection.attempts.length,
          nextItemOffset:
            itemOffset + itemLimit < collection.items.length
              ? itemOffset + itemLimit
              : null,
          nextAttemptOffset:
            attemptOffset + attemptLimit < collection.attempts.length
              ? attemptOffset + attemptLimit
              : null,
        },
        timelineLimits:
          "Only recorded lease/start and completion times are projected. Consumption/recovery times and completion actor are not recorded in this snapshot.",
      }),
    },
  ];
  const itemRef = (id: string) =>
    reference(
      c,
      "acquisition-item",
      digest({ collectionId: collection.id, itemId: id }),
      revision,
    );
  for (const item of collection.items.filter((i) => selected.has(i.id))) {
    const history = collection.attempts.filter((a) => a.itemId === item.id),
      last = history.at(-1);
    nodes.push({
      ref: itemRef(item.id),
      label: item.id,
      kind: "source",
      state: last?.status ?? "unseen",
      stage,
      dependencies: [root],
      summary: last
        ? `${history.length} recorded attempt(s); latest ${last.status}.`
        : "No acquisition attempt is recorded.",
      details: json({
        collectionId: collection.id,
        storageRevision: revision,
        item,
        attemptCount: history.length,
        lastAttemptId: last?.id ?? null,
      }),
    });
  }
  const receipts = new Map<string, Ref>(),
    events: VisualEvent[] = [];
  for (const attempt of visibleAttempts) {
    const lease = leases.get(attempt.id)!,
      ref = reference(
        c,
        "acquisition-attempt",
        digest({ collectionId: collection.id, attemptId: attempt.id }),
        revision,
      ),
      dependencies = [itemRef(attempt.itemId)];
    if (lease.receipt) {
      const receiptKey = refKey(lease.receipt),
        existing = receipts.get(receiptKey);
      invariant(
        !existing || digest(existing) === digest(lease.receipt),
        "reference_collision",
        "Distinct receipt references share an ambiguous display key",
      );
      if (!existing) {
        receipts.set(receiptKey, lease.receipt);
        nodes.push({
          ref: lease.receipt,
          label: "Outcome receipt " + lease.receipt.id,
          kind: "source",
          state: "stored-reference",
          stage,
          dependencies: [],
          summary:
            "Exact receipt edition stored by the scheduler. Receipt content and current permissions are not reread by this projection.",
          details: json({ receipt: lease.receipt }),
        });
      }
      dependencies.push(lease.receipt);
    }
    nodes.push({
      ref,
      label: "Attempt " + attempt.id,
      kind: "task",
      state:
        lease.status === "reconcile"
          ? "reconciliation-required"
          : attempt.status === "started"
            ? lease.status
            : attempt.status,
      stage,
      dependencies,
      summary:
        lease.status === "reconcile"
          ? "Consumed work has an unresolved outcome. It remains blocked; do not infer failure or retry."
          : lease.status === "running"
            ? "Work was consumed; no successful capture is recorded yet."
            : `Acquisition attempt is ${lease.status}.`,
      details: json({
        collectionId: collection.id,
        storageRevision: revision,
        attempt,
        worker: { id: lease.actorId, kind: lease.actorKind },
        lease: {
          leasedAt: lease.leasedAt,
          expiresAt: lease.expiresAt,
          status: lease.status,
        },
        receipt: lease.receipt,
      }),
    });
    events.push({
      id: digest({
        collectionId: collection.id,
        attemptId: attempt.id,
        event: "leased",
      }),
      at: lease.leasedAt,
      actorId: lease.actorId,
      action: "acquisition.leased",
      resource: ref,
      summary:
        "Lease and attempt recorded; this event does not establish that network work began.",
    });
    if (attempt.completedAt)
      events.push({
        id: digest({
          collectionId: collection.id,
          attemptId: attempt.id,
          event: "completed",
        }),
        at: attempt.completedAt,
        actorId: "not recorded",
        action: "acquisition." + attempt.status,
        resource: ref,
        summary:
          "Recorded completion. Completion actor is not retained in this snapshot; lease owner is shown separately.",
      });
  }
  const result: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private acquisition coverage and recovery",
    capturedAt: c.now,
    nodes,
    events,
    agents: [],
  };
  layoutWorkspace(c, result);
  return result;
}
