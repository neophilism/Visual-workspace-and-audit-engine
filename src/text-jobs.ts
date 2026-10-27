import type { TextJobSnapshot } from "@accountability/processing/text-jobs";
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
import type { VisualNode, WorkspaceSnapshot, WorkStage } from "./index.ts";
const fields = (v: object, required: string[], optional: string[] = []) => {
  invariant(
    required.every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => [...required, ...optional].includes(k)),
    "invalid_text_job",
    "Unexpected or missing text job fields",
  );
};
const sha = (v: string) =>
  invariant(
    typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    "invalid_text_job",
    "Exact SHA256 required",
  );
const jobRef = (c: Context, id: string, revision: number): Ref =>
  validateRef({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind: "text-processing-job",
    id: digest({ id }),
    revision,
  });
/** Authorized host snapshot only. No storage reads, verification, dispatch or retry controls. */
export function projectTextJob(
  c: Context,
  supplied: TextJobSnapshot,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(canonical(supplied), "utf8") <= 65536,
    "projection_too_large",
    "Text job snapshot exceeds 64KiB",
  );
  const input = structuredClone(supplied),
    j = input.job;
  fields(input, ["job", "revision"]);
  fields(
    j,
    [
      "id",
      "source",
      "sourceSha256",
      "sourceBytes",
      "language",
      "purpose",
      "profile",
      "status",
      "workerId",
      "workerKind",
      "leaseExpiresAt",
      "outcome",
      "submittedAt",
      "submittedBy",
      "consumedAt",
    ],
    ["failure", "retry"],
  );
  nonempty(j.id, "job id", 128);
  nonempty(j.purpose, "purpose", 200);
  nonempty(j.submittedBy, "submitter", 128);
  invariant(
    j.purpose === c.purpose && j.profile === "utf8-text@1.0.0",
    "purpose_denied",
    "Exact purpose and supported profile required",
  );
  invariant(
    Number.isSafeInteger(j.sourceBytes) &&
      j.sourceBytes >= 0 &&
      j.sourceBytes <= 5 * 1024 * 1024,
    "invalid_text_job",
    "Invalid source byte count",
  );
  if (j.language !== null) nonempty(j.language, "language", 64);
  sha(j.sourceSha256);
  validTime(j.submittedAt);
  const root = jobRef(c, j.id, input.revision);
  const nodes: VisualNode[] = [];
  const used = new Set([refKey(root)]);
  function linked(ref: Ref, label: string): Ref {
    fields(ref, ["tenantId", "projectId", "kind", "id", "revision"]);
    validateRef(ref);
    requireScope(c, ref);
    invariant(
      ref.kind !== "text-processing-job",
      "reference_collision",
      "External reference uses job storage kind",
    );
    invariant(
      !used.has(refKey(ref)),
      "reference_collision",
      "Distinct job reference roles collide",
    );
    used.add(refKey(ref));
    nodes.push({
      ref,
      label,
      kind: "artifact",
      state: "referenced-not-independently-read",
      stage,
      dependencies: [],
      summary:
        "Exact edition reference from the authorized job record; content and current permission were not independently fetched.",
      details: { reference: ref } as unknown as Json,
    });
    return ref;
  }
  const dependencies: Ref[] = [linked(j.source, "Exact source edition")];
  const status = [
    "queued",
    "leased",
    "consumed",
    "completed",
    "failed",
    "cancelled",
  ];
  invariant(
    status.includes(j.status),
    "invalid_text_job",
    "Unknown job status",
  );
  const minimum = {
    queued: 1,
    leased: 2,
    consumed: 3,
    completed: 4,
    failed: 4,
    cancelled: 2,
  };
  invariant(
    input.revision >= minimum[j.status],
    "invalid_text_job",
    "Status lacks required stored revisions",
  );
  if (j.status === "queued")
    invariant(
      input.revision === 1,
      "invalid_text_job",
      "Queued job must be its first stored edition",
    );
  const assigned = j.workerId !== null;
  if (assigned) {
    nonempty(j.workerId!, "worker", 128);
    invariant(
      ["service", "agent"].includes(j.workerKind ?? "") &&
        j.leaseExpiresAt !== null,
      "invalid_text_job",
      "Worker assignment incomplete",
    );
    invariant(
      validTime(j.leaseExpiresAt!) > validTime(j.submittedAt),
      "invalid_text_job",
      "Invalid lease time",
    );
  } else
    invariant(
      j.workerKind === null && j.leaseExpiresAt === null,
      "invalid_text_job",
      "Unassigned job contains a lease",
    );
  const executed = ["consumed", "completed", "failed"].includes(j.status);
  invariant(
    executed ? assigned && j.consumedAt !== null : j.consumedAt === null,
    "invalid_text_job",
    "Consumption metadata differs from status",
  );
  if (executed)
    invariant(
      validTime(j.consumedAt!) >= validTime(j.submittedAt) &&
        validTime(j.consumedAt!) < validTime(j.leaseExpiresAt!),
      "invalid_text_job",
      "Consumption outside lease",
    );
  if (j.status === "queued")
    invariant(
      !assigned,
      "invalid_text_job",
      "Queued job cannot retain assignment",
    );
  if (j.status === "leased")
    invariant(assigned, "invalid_text_job", "Leased job needs assignment");
  if (j.status === "completed") {
    invariant(
      j.outcome !== null,
      "invalid_text_job",
      "Completed job lacks outcome",
    );
    fields(j.outcome!, ["derivative", "sha256", "receipt"]);
    sha(j.outcome!.sha256);
    dependencies.push(
      linked(j.outcome!.derivative, "Exact private derivative"),
      linked(j.outcome!.receipt, "Exact outcome receipt"),
    );
  } else
    invariant(
      j.outcome === null,
      "invalid_text_job",
      "Non-completed job carries outcome",
    );
  if (j.status === "failed") {
    invariant(
      j.failure !== undefined,
      "invalid_text_job",
      "Failed job lacks stopped/no-output proof",
    );
    fields(j.failure!, [
      "receipt",
      "reason",
      "processorStopped",
      "noDerivative",
    ]);
    invariant(
      j.failure!.processorStopped === true &&
        j.failure!.noDerivative === true &&
        [
          "processor-failed",
          "cancelled-before-processing",
          "runtime-expired",
        ].includes(j.failure!.reason),
      "invalid_text_job",
      "Invalid terminal failure proof",
    );
    dependencies.push(
      linked(j.failure!.receipt, "Exact stopped/no-output receipt"),
    );
  } else
    invariant(
      !Object.hasOwn(j, "failure"),
      "invalid_text_job",
      "Only failed jobs carry failure proof",
    );
  if (j.retry) {
    const r = j.retry;
    fields(r, [
      "rootJobId",
      "generation",
      "parentJobId",
      "parentFailedRevision",
      "failureReceipt",
    ]);
    nonempty(r.rootJobId, "root job", 128);
    nonempty(r.parentJobId, "parent job", 128);
    invariant(
      Number.isSafeInteger(r.generation) &&
        r.generation >= 1 &&
        r.generation <= 16 &&
        Number.isSafeInteger(r.parentFailedRevision) &&
        r.parentFailedRevision >= 4 &&
        j.id ===
          `retry-${digest({ parentJobId: r.parentJobId, failedRevision: r.parentFailedRevision })}` &&
        r.parentJobId !== j.id &&
        (r.generation === 1
          ? r.rootJobId === r.parentJobId
          : r.rootJobId !== r.parentJobId),
      "invalid_text_job",
      "Invalid retry lineage binding",
    );
    const parent = jobRef(c, r.parentJobId, r.parentFailedRevision);
    invariant(
      !used.has(refKey(parent)),
      "reference_collision",
      "Retry parent collides",
    );
    used.add(refKey(parent));
    nodes.push({
      ref: parent,
      label: "Referenced parent failed edition",
      kind: "task",
      state: "referenced-parent-content-not-loaded",
      stage,
      dependencies: [],
      summary:
        "Parent failed-edition link recorded by the child. Parent contents and receipt validity were not independently loaded.",
      details: { parentJobId: r.parentJobId },
    });
    dependencies.push(
      parent,
      linked(r.failureReceipt, "Parent stopped/no-output receipt"),
    );
  } else
    invariant(
      !Object.hasOwn(j, "retry"),
      "invalid_text_job",
      "Retry metadata cannot be empty",
    );
  nodes.push({
    ref: root,
    label: `Text job ${j.id}`,
    kind: "task",
    state: j.status === "consumed" ? "consumed-outcome-unresolved" : j.status,
    stage,
    dependencies,
    summary:
      j.status === "consumed"
        ? "Execution was consumed; outcome remains unresolved. Lease expiry does not permit retry."
        : "Stored job state only. Retry queue receipts are not execution permits; new jobs require fresh authorization and consumption.",
    details: JSON.parse(
      canonical({
        job: j,
        metadataNotice:
          "Submission and consumption times are record metadata, not independently supplied audit events. Terminal completion/failure time and actor are not recorded. No live agent, receipt validation or current use permission is inferred.",
      }),
    ) as Json,
  });
  const snapshot: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private text processing job audit",
    capturedAt: c.now,
    nodes,
    agents: [],
    events: [],
  };
  layoutWorkspace(c, snapshot);
  return snapshot;
}
