import { inspectPlans } from "@accountability/factual-investigation";
import { inspectEfforts } from "@accountability/factual-investigation/efforts";
import {
  PLANNING_KIND,
  PLANNING_KEY,
  EFFORT_KIND,
  EFFORT_KEY,
} from "@accountability/factual-investigation/repository";
import type {
  FactualRepository,
  PlanningSnapshot,
} from "@accountability/factual-investigation/repository";
import {
  canonical,
  invariant,
  refKey,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace } from "./index.ts";
import type { VisualNode, WorkspaceSnapshot, WorkStage } from "./index.ts";
type EffortSnapshot = Awaited<ReturnType<FactualRepository["loadEfforts"]>>;
const exact = (value: object, keys: string[]) =>
  invariant(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "invalid_factual_snapshot",
    "Exact snapshot fields required",
  );
const same = (a: Ref, b: Ref) => canonical(a) === canonical(b);
/** Authorized private owning snapshots only; read-only, no authentication/coverage/closure inference. */
export function projectFactualPlan(
  context: Context,
  planningInput: PlanningSnapshot,
  effortInput: EffortSnapshot,
  selected: Ref,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(canonical({ planningInput, effortInput })) <=
      4 * 1024 * 1024,
    "projection_too_large",
    "Factual input exceeds 4MiB",
  );
  const c = structuredClone(context),
    planning = structuredClone(planningInput),
    efforts = structuredClone(effortInput),
    choice = structuredClone(selected);
  exact(planning, ["revision", "state"]);
  exact(efforts, ["revision", "state", "planningRevision"]);
  const plans = inspectPlans(c, planning.state),
    ledger = inspectEfforts(c, efforts.state);
  invariant(
    Number.isSafeInteger(planning.revision) &&
      planning.revision === plans.length &&
      Number.isSafeInteger(efforts.revision) &&
      efforts.revision === ledger.history.length &&
      efforts.planningRevision === planning.revision,
    "invalid_factual_snapshot",
    "Matching owning storage/history revisions required",
  );
  const check = (r: Ref) => {
    exact(r, ["tenantId", "projectId", "kind", "id", "revision"]);
    validateRef(r);
    requireScope(c, r);
  };
  check(choice);
  for (const p of plans) {
    check(p.ref);
    if (p.supersedes) check(p.supersedes);
    if (p.value.intakeCaseRef) check(p.value.intakeCaseRef);
    for (const r of [
      ...p.value.basisClaimRefs,
      ...p.value.questions.flatMap((q) =>
        q.hypotheses.flatMap((h) => h.claimRefs),
      ),
    ])
      check(r);
    invariant(
      p.purpose === c.purpose,
      "purpose_denied",
      "Exact record purpose required",
    );
  }
  for (const r of ledger.history) {
    check(r.ref);
    check(r.plan);
    if (r.corrects) check(r.corrects);
    const p = plans.find((p) => same(p.ref, r.plan)),
      q = p?.value.questions.find((q) => q.id === r.questionId);
    invariant(
      q && (r.leadId === null || q.leads.some((l) => l.id === r.leadId)),
      "missing_reference",
      "Effort must bind an actual captured plan question/lead",
    );
    invariant(
      r.purpose === c.purpose,
      "purpose_denied",
      "Exact record purpose required",
    );
  }
  const plan = plans.find((p) => same(p.ref, choice));
  invariant(plan, "missing_reference", "Selected exact plan edition required");
  const latest = plans.filter((p) => p.ref.id === plan.ref.id).at(-1)!;
  const nodes: VisualNode[] = [];
  const used = new Set<string>();
  const add = (node: VisualNode) => {
    invariant(
      !used.has(refKey(node.ref)),
      "reference_collision",
      "Distinct projection roles required",
    );
    used.add(refKey(node.ref));
    nodes.push(node);
    invariant(
      nodes.length <= 256 &&
        nodes.reduce((n, x) => n + x.dependencies.length, 0) <= 512,
      "projection_too_large",
      "Factual view exceeds 256 nodes/512 edges",
    );
  };
  const store = (kind: string, id: string, revision: number) =>
    validateRef({
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind,
      id,
      revision,
    });
  const planStore = store(PLANNING_KIND, PLANNING_KEY, planning.revision);
  add({
    ref: planStore,
    label: "Captured planning storage edition",
    kind: "artifact",
    state: "captured-storage-edition",
    stage,
    dependencies: [],
    summary:
      "Observed containing storage edition, not the plan's creation audit.",
    details: { revision: planning.revision },
  });
  const dependencies: Ref[] = [planStore];
  for (const r of [
    ...plan.value.basisClaimRefs,
    ...plan.value.questions.flatMap((q) =>
      q.hypotheses.flatMap((h) => h.claimRefs),
    ),
    ...(plan.value.intakeCaseRef ? [plan.value.intakeCaseRef] : []),
  ]) {
    if (!used.has(refKey(r)))
      add({
        ref: r,
        label:
          r.kind === "claim"
            ? "Referenced Knowledge claim"
            : "Referenced intake case",
        kind: r.kind === "claim" ? "claim" : "artifact",
        state: "referenced-not-independently-read",
        stage,
        dependencies: [],
        summary:
          "Exact captured reference only; current content, permission and transitive dependencies were not independently read.",
        details: { reference: r } as unknown as Json,
      });
    if (!dependencies.some((d) => same(d, r))) dependencies.push(r);
  }
  if (plan.supersedes) {
    add({
      ref: plan.supersedes,
      label: "Previous plan edition",
      kind: "objective",
      state: "predecessor-not-expanded",
      stage,
      dependencies: [],
      summary:
        "Exact retained predecessor; its questions and dependencies are not expanded in this selected view.",
      details: { reference: plan.supersedes } as unknown as Json,
    });
    dependencies.push(plan.supersedes);
  }
  add({
    ref: plan.ref,
    label: plan.value.title.slice(0, 200),
    kind: "objective",
    state: same(plan.ref, latest.ref)
      ? "current-captured-plan-edition"
      : "historical-plan-edition",
    stage,
    dependencies,
    summary:
      "Ordered questions, materiality and contrary-testing routes are literal planning metadata. No evaluated answers or closure are inferred.",
    details: JSON.parse(
      canonical({
        record: plan,
        containingStorage: planStore,
        latestPlanRef: latest.ref,
        notice:
          "Actor/time/request are record metadata, not authentication or audit events. Questions/leads have no invented stored refs.",
      }),
    ) as Json,
  });
  const selectedEfforts = ledger.history.filter((r) => same(r.plan, plan.ref));
  if (selectedEfforts.length) {
    const effortStore = store(EFFORT_KIND, EFFORT_KEY, efforts.revision);
    add({
      ref: effortStore,
      label: "Captured effort storage edition",
      kind: "artifact",
      state: "captured-storage-edition",
      stage,
      dependencies: [],
      summary:
        "Observed containing effort storage edition; historical metadata only, not current coverage or proof of work.",
      details: {
        revision: efforts.revision,
        planningRevision: efforts.planningRevision,
      },
    });
    for (const r of selectedEfforts) {
      const correctedBy =
        selectedEfforts.find((x) => x.corrects && same(x.corrects, r.ref))
          ?.ref ?? null;
      add({
        ref: r.ref,
        label: `Effort ${r.ref.id}`.slice(0, 200),
        kind: "task",
        state: `${r.outcome}-unresolved`,
        stage,
        dependencies: [
          plan.ref,
          effortStore,
          ...(r.corrects ? [r.corrects] : []),
        ],
        summary:
          "Literal unresolved account; corrections retain prior records. Historical attempts do not resolve current questions.",
        details: JSON.parse(
          canonical({
            record: r,
            correctedBy,
            containingStorage: effortStore,
            planEditionIsLatest: same(plan.ref, latest.ref),
          }),
        ) as Json,
      });
    }
  }
  const output: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private investigation plan and effort review",
    capturedAt: c.now,
    nodes,
    agents: [],
    events: [],
  };
  invariant(
    Buffer.byteLength(canonical(output)) <= 512 * 1024,
    "projection_too_large",
    "Factual output exceeds 512KiB",
  );
  layoutWorkspace(c, output);
  return output;
}
