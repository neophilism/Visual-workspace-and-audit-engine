import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TextJobSnapshot } from "@accountability/processing/text-jobs";
import { digest, refKey } from "../src/contracts.ts";
import { projectTextJob } from "../src/text-jobs.ts";
import { renderWorkspace } from "../src/index.ts";
const c = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "owner", kind: "human" as const, roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const ref = {
  tenantId: c.tenantId,
  projectId: c.projectId,
  kind: "evidence",
  id: "source",
  revision: 2,
};
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
function fixture(): Mutable<TextJobSnapshot> {
  return {
    revision: 4,
    job: {
      id: "one",
      source: ref,
      sourceSha256: "a".repeat(64),
      sourceBytes: 5,
      language: null,
      purpose: c.purpose,
      profile: "utf8-text@1.0.0",
      status: "failed",
      workerId: "worker",
      workerKind: "service",
      leaseExpiresAt: "2026-01-01T00:01:00Z",
      outcome: null,
      submittedAt: c.now,
      submittedBy: "owner",
      consumedAt: c.now,
      failure: {
        receipt: { ...ref, kind: "receipt", id: "stopped", revision: 3 },
        reason: "processor-failed",
        processorStopped: true,
        noDerivative: true,
      },
    },
  };
}
test("failed and consumed projections preserve storage keys, proof editions and explicit metadata gaps without agents or events", () => {
  const f = fixture(),
    s = projectTextJob(c, f, "tested");
  assert.deepEqual(s.agents, []);
  assert.deepEqual(s.events, []);
  assert.equal(s.visibility, "private");
  const task = s.nodes.find((n) => n.ref.kind === "text-processing-job")!;
  assert.equal(task.ref.id, digest({ id: "one" }));
  assert.equal(task.ref.revision, 4);
  assert.equal(task.state, "failed");
  assert.match(JSON.stringify(task.details), /not recorded/);
  assert.ok(
    s.nodes.some((n) => refKey(n.ref) === refKey(f.job.failure!.receipt)),
  );
  const pending = fixture();
  delete pending.job.failure;
  (pending.job as { status: string }).status = "consumed";
  pending.revision = 3;
  assert.equal(
    projectTextJob(c, pending, "implemented").nodes.at(-1)!.state,
    "consumed-outcome-unresolved",
  );
});
test("retry queue retains exact parent failure and source editions while remaining a separate queued job", () => {
  const f = fixture();
  f.job.id = `retry-${digest({ parentJobId: "one", failedRevision: 4 })}`;
  f.revision = 1;
  f.job = {
    ...f.job,
    status: "queued",
    workerId: null,
    workerKind: null,
    leaseExpiresAt: null,
    consumedAt: null,
    retry: {
      rootJobId: "one",
      generation: 1,
      parentJobId: "one",
      parentFailedRevision: 4,
      failureReceipt: f.job.failure!.receipt,
    },
  };
  delete f.job.failure;
  const s = projectTextJob(c, f, "tested"),
    root = s.nodes.at(-1)!;
  assert.equal(root.state, "queued");
  assert.match(root.summary, /not execution permits/);
  assert.equal(
    s.nodes.find((n) => n.state === "referenced-parent-content-not-loaded")!.ref
      .revision,
    4,
  );
  for (const change of [
    () => {
      f.job.retry!.generation = 17;
    },
    () => {
      f.job.retry!.parentFailedRevision = 3;
    },
    () => {
      f.job.id = "invented-child";
    },
    () => {
      f.job.retry!.failureReceipt = { ...ref, projectId: "foreign" };
    },
  ]) {
    const old = structuredClone(f);
    change();
    assert.throws(() => projectTextJob(c, f, "tested"));
    Object.assign(f, old);
  }
});
test("foreign hidden proof references, inconsistent states, collisions and unknown payload fields fail closed", () => {
  const mutations = [
    (f: Mutable<TextJobSnapshot>) => {
      f.job.source = { ...ref, projectId: "foreign" };
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.failure!.receipt = { ...ref, tenantId: "foreign" };
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.purpose = "other";
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.status = "completed";
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.workerId = null;
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.revision = 2;
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.failure!.receipt = ref;
    },
    (f: Mutable<TextJobSnapshot>) => {
      Object.assign(f.job, { credential: "must never be copied" });
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.sourceSha256 = "invalid";
    },
    (f: Mutable<TextJobSnapshot>) => {
      f.job.leaseExpiresAt = c.now;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => projectTextJob(c, f, "tested"));
  }
  const large = fixture();
  Object.assign(large.job, { extra: "x".repeat(65536) });
  assert.throws(() => projectTextJob(c, large, "tested"), {
    code: "projection_too_large",
  });
});
test("shared table and SVG inspectors show identical literal job detail and inert injected text", () => {
  const f = fixture();
  f.job.id = "</script><script>globalThis.injected=true</script>";
  const s = projectTextJob(c, f, "tested");
  const dom = new JSDOM(renderWorkspace(c, s), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
    },
  });
  const doc = dom.window.document;
  const buttons = [...doc.querySelectorAll("button[data-node]")];
  const button = buttons.find((b) => b.textContent === `Text job ${f.job.id}`)!;
  assert.ok(button);
  (button as HTMLButtonElement).click();
  const text = doc.getElementById("detail")!.textContent;
  assert.match(text!, /processor-failed/);
  assert.match(text!, /not recorded/);
  const svg = doc.querySelector(
    `g[data-node="${button.getAttribute("data-node")}"]`,
  )!;
  svg.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.equal(doc.getElementById("detail")!.textContent, text);
  assert.equal(
    (dom.window as unknown as { injected?: boolean }).injected,
    undefined,
  );
  dom.window.close();
});
