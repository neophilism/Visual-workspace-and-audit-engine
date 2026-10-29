import { writeFile } from "node:fs/promises";
import {
  createPlanningState,
  revisePlan,
} from "@accountability/factual-investigation";
import {
  createEffortState,
  recordEffort,
} from "@accountability/factual-investigation/efforts";
import { createKnowledgeState } from "@accountability/knowledge-verification";
import { projectFactualPlan } from "../dist/factual-review.js";
import { renderWorkspace } from "../dist/index.js";
const c = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "fictional-reviewer", kind: "human", roles: ["owner"] },
  purpose: "private-review",
  requestId: "fictional-example",
  now: "2026-01-01T00:00:00Z",
};
const planning = revisePlan(
  c,
  createKnowledgeState(c),
  createPlanningState(c),
  {
    id: "fictional-plan",
    expectedRevision: 0,
    value: {
      title: "Fictional signal review — unresolved",
      intakeCaseRef: null,
      basisClaimRefs: [],
      questions: [
        {
          id: "sequence",
          parentId: null,
          text: "Which event preceded the fictional signal?",
          material: true,
          whyMaterial: "Distinguishes competing sequences",
          hypotheses: [
            {
              id: "earlier",
              explanation: "The lamp may have been lit first",
              claimRefs: [],
              contraryTest: "Seek an authorized record of the reverse sequence",
            },
          ],
          leads: [],
          stopCondition:
            "Pause if authorized records are unavailable; remain unresolved",
        },
      ],
    },
  },
);
const plan = planning.records[0].ref;
let effort = createEffortState(c);
effort = recordEffort(c, planning, effort, {
  id: "attempt",
  expectedSequence: 0,
  plan,
  questionId: "sequence",
  leadId: null,
  outcome: "unavailable",
  detail: "Fictional example only: record unavailable",
  corrects: null,
});
effort = recordEffort(c, planning, effort, {
  id: "correction",
  expectedSequence: 1,
  plan,
  questionId: "sequence",
  leadId: null,
  outcome: "attempted",
  detail: "Correction of fictional unresolved account; no proof of work",
  corrects: effort.records[0].ref,
});
const snapshot = projectFactualPlan(
  c,
  { revision: 1, state: planning },
  { revision: 2, state: effort, planningRevision: 1 },
  plan,
  "tested",
);
await writeFile(
  new URL("../docs/examples/private-factual-review.html", import.meta.url),
  renderWorkspace(c, snapshot),
);
