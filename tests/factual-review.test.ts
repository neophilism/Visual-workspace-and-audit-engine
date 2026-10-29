import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createPlanningState,
  revisePlan,
} from "@accountability/factual-investigation";
import type { Plan } from "@accountability/factual-investigation";
import {
  createEffortState,
  recordEffort,
} from "@accountability/factual-investigation/efforts";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import { projectFactualPlan } from "../src/factual-review.ts";
import { renderWorkspace } from "../src/index.ts";
const c = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "owner", kind: "human" as const, roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
function fixture() {
  const knowledge = reviseKnowledge(c, createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim",
      text: "A fictional lamp was lit",
      subjectRefs: [],
      time: { earliest: null, latest: null },
      accountType: "observation",
      limitations: ["Unverified fixture"],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  });
  const value: Plan = {
    title: "Fictional lamp review",
    intakeCaseRef: null,
    basisClaimRefs: [knowledge.records[0]!.ref],
    questions: [
      {
        id: "time",
        parentId: null,
        text: "When was the lamp lit?",
        material: true,
        whyMaterial: "Distinguishes sequences",
        hypotheses: [
          {
            id: "early",
            explanation: "Before the signal",
            claimRefs: [knowledge.records[0]!.ref],
            contraryTest: "Seek the reverse sequence",
          },
        ],
        leads: [{ id: "log", description: "Separately authorized log" }],
        stopCondition: "Pause if unavailable; remain unresolved",
      },
    ],
  };
  let planning = revisePlan(c, knowledge, createPlanningState(c), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  const selected = planning.records[0]!.ref;
  let efforts = recordEffort(c, planning, createEffortState(c), {
    id: "attempt",
    expectedSequence: 0,
    plan: selected,
    questionId: "time",
    leadId: "log",
    outcome: "unavailable",
    detail: "Fictional record unavailable",
    corrects: null,
  });
  efforts = recordEffort(c, planning, efforts, {
    id: "correct",
    expectedSequence: 1,
    plan: selected,
    questionId: "time",
    leadId: "log",
    outcome: "attempted",
    detail: "Correction of unresolved metadata",
    corrects: efforts.records[0]!.ref,
  });
  planning = revisePlan(c, knowledge, planning, {
    id: "plan",
    expectedRevision: 1,
    value: { ...value, title: "Revised fictional review" },
  });
  return {
    knowledge,
    value,
    planning: { revision: 2, state: planning },
    efforts: { revision: 2, state: efforts, planningRevision: 2 },
    selected,
  };
}
test("exact historical plans and corrected efforts retain containing editions and unresolved metadata without invented events or agents", () => {
  const f = fixture(),
    out = projectFactualPlan(c, f.planning, f.efforts, f.selected, "tested");
  assert.equal(out.visibility, "private");
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.agents, []);
  assert.equal(
    out.nodes.find((n) => n.ref.kind === "investigation-plan")!.state,
    "historical-plan-edition",
  );
  const attempt = out.nodes.find((n) => n.ref.id === "attempt")!;
  assert.equal(attempt.state, "unavailable-unresolved");
  assert.match(JSON.stringify(attempt.details), /correctedBy.*correct/);
  assert.equal(out.nodes.filter((n) => n.ref.kind === "claim").length, 1);
  assert.ok(
    out.nodes.some(
      (n) => n.ref.kind === "factual-planning-history" && n.ref.revision === 2,
    ),
  );
  assert.ok(
    out.nodes.some(
      (n) => n.ref.kind === "factual-effort-history" && n.ref.revision === 2,
    ),
  );
  assert.match(JSON.stringify(out), /When was the lamp lit/);
  const current = projectFactualPlan(
    c,
    f.planning,
    f.efforts,
    f.planning.state.records[1]!.ref,
    "tested",
  );
  assert.ok(
    current.nodes.some((n) => n.state === "current-captured-plan-edition"),
  );
  assert.ok(current.nodes.some((n) => n.state === "predecessor-not-expanded"));
  assert.equal(
    current.nodes.filter((n) => n.ref.kind === "investigation-effort").length,
    0,
  );
  out.nodes[0]!.label = "Caller change";
  assert.notEqual(
    projectFactualPlan(c, f.planning, f.efforts, f.selected, "tested").nodes[0]!
      .label,
    "Caller change",
  );
});
test("mismatched storage scope purpose and actual effort question bindings fail closed", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.efforts.planningRevision = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.planning.revision = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.efforts.state.records[0]!, { questionId: "missing" });
      Object.assign(f.efforts.state.records[1]!, { questionId: "missing" });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.planning.state, { projectId: "foreign" });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.planning.state.records[0]!, { purpose: "other" });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.selected, { credential: "must not be copied" });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.efforts, { secret: "must not be copied" });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      projectFactualPlan(c, f.planning, f.efforts, f.selected, "tested"),
    );
  }
  const f = fixture();
  assert.throws(() =>
    projectFactualPlan(
      { ...c, actor: { ...c.actor, roles: ["viewer"] } },
      f.planning,
      f.efforts,
      f.selected,
      "tested",
    ),
  );
});
test("table and keyboard SVG inspectors expose identical inert literal questions and effort correction metadata", () => {
  const f = fixture(),
    text = "</script><script>globalThis.injected=true</script>";
  Object.assign(f.planning.state.records[0]!.value, { title: text });
  const out = projectFactualPlan(
    c,
    f.planning,
    f.efforts,
    f.selected,
    "tested",
  );
  const dom = new JSDOM(renderWorkspace(c, out), {
    runScripts: "dangerously",
    beforeParse(w) {
      w.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
    },
  });
  const doc = dom.window.document,
    button = [...doc.querySelectorAll("button[data-node]")].find(
      (b) => b.textContent === text,
    )!;
  assert.ok(button);
  (button as HTMLButtonElement).click();
  const detail = doc.getElementById("detail")!.textContent;
  assert.match(detail!, /whyMaterial/);
  assert.match(detail!, /contraryTest/);
  doc
    .querySelector(`g[data-node="${button.getAttribute("data-node")}"]`)!
    .dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  assert.equal(doc.getElementById("detail")!.textContent, detail);
  assert.equal(
    (dom.window as unknown as { injected?: boolean }).injected,
    undefined,
  );
  const effort = [...doc.querySelectorAll("button[data-node]")].find(
    (b) => b.textContent === "Effort attempt",
  )!;
  (effort as HTMLButtonElement).click();
  assert.match(doc.getElementById("detail")!.textContent!, /correctedBy/);
  dom.window.close();
});
test("input and output byte budgets reject full views without truncating or mutating histories", () => {
  const f = fixture();
  assert.throws(
    () =>
      projectFactualPlan(
        c,
        Object.assign(structuredClone(f.planning), {
          oversize: "x".repeat(4 * 1024 * 1024),
        }),
        f.efforts,
        f.selected,
        "tested",
      ),
    { code: "projection_too_large" },
  );
  const questions = Array.from({ length: 64 }, (_, i) => ({
    ...f.value.questions[0]!,
    id: `q${i}`,
    text: "x".repeat(4000),
    whyMaterial: "x".repeat(4000),
    stopCondition: "x".repeat(4000),
    hypotheses: [
      {
        id: "h",
        explanation: "x".repeat(4000),
        claimRefs: [],
        contraryTest: "x".repeat(4000),
      },
    ],
    leads: [],
  }));
  const state = revisePlan(c, f.knowledge, createPlanningState(c), {
      id: "large",
      expectedRevision: 0,
      value: { ...f.value, questions },
    }),
    before = structuredClone(state);
  assert.throws(
    () =>
      projectFactualPlan(
        c,
        { revision: 1, state },
        { revision: 0, state: createEffortState(c), planningRevision: 1 },
        state.records[0]!.ref,
        "tested",
      ),
    { code: "projection_too_large" },
  );
  assert.deepEqual(state, before);
});

test("node and edge ceilings accept their boundary views then reject without partial projection", () => {
  const f = fixture();
  function make(
    knowledge: ReturnType<typeof createKnowledgeState>,
    value: Plan,
    count: number,
    chain: boolean,
  ) {
    const planning = revisePlan(c, knowledge, createPlanningState(c), {
        id: "bounded",
        expectedRevision: 0,
        value,
      }),
      plan = planning.records[0]!.ref;
    let efforts = createEffortState(c);
    for (let i = 0; i < count; i++)
      efforts = recordEffort(c, planning, efforts, {
        id: `e${i}`,
        expectedSequence: i,
        plan,
        questionId: "time",
        leadId: null,
        outcome: "attempted",
        detail: "Unresolved fixture",
        corrects: chain && i > 0 ? efforts.records.at(-1)!.ref : null,
      });
    return {
      planning: { revision: 1, state: planning },
      efforts: { revision: count, state: efforts, planningRevision: 1 },
      plan,
    };
  }
  const nodeLimit = make(f.knowledge, f.value, 252, false);
  assert.equal(
    projectFactualPlan(
      c,
      nodeLimit.planning,
      nodeLimit.efforts,
      nodeLimit.plan,
      "tested",
    ).nodes.length,
    256,
  );
  const nodeOver = make(f.knowledge, f.value, 253, false);
  assert.throws(
    () =>
      projectFactualPlan(
        c,
        nodeOver.planning,
        nodeOver.efforts,
        nodeOver.plan,
        "tested",
      ),
    { code: "projection_too_large" },
  );
  const knowledge = reviseKnowledge(c, f.knowledge, {
    id: "claim-two",
    expectedRevision: 0,
    value: f.knowledge.records[0]!.value,
  });
  const value = {
    ...f.value,
    basisClaimRefs: knowledge.records.map((r) => r.ref),
  };
  const edgeLimit = make(knowledge, value, 170, true),
    out = projectFactualPlan(
      c,
      edgeLimit.planning,
      edgeLimit.efforts,
      edgeLimit.plan,
      "tested",
    );
  assert.equal(
    out.nodes.reduce((n, x) => n + x.dependencies.length, 0),
    512,
  );
  const edgeOver = make(knowledge, value, 171, true);
  assert.throws(
    () =>
      projectFactualPlan(
        c,
        edgeOver.planning,
        edgeOver.efforts,
        edgeOver.plan,
        "tested",
      ),
    { code: "projection_too_large" },
  );
});
