import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { view, receipt, fixture } from "./acquisition-helpers.ts";
import { projectAcquisition } from "../src/acquisition.ts";
import { renderWorkspace, layoutWorkspace } from "../src/index.ts";
test("acquisition audit preserves global coverage, uncertainty and exact receipt/containing revisions", () => {
  const snapshot = projectAcquisition(view, fixture(), "tested");
  assert.equal(snapshot.visibility, "private");
  assert.deepEqual(snapshot.agents, []);
  const root = snapshot.nodes.find((n) => n.kind === "objective")!;
  assert.match(root.summary, /1 of 5 planned items/);
  assert.match(root.summary, /not incident counts/);
  assert.equal(root.state, "enabled-with-unresolved-work");
  const uncertain = snapshot.nodes.find(
    (n) => n.state === "reconciliation-required",
  )!;
  assert.match(uncertain.summary, /remains blocked/);
  assert(
    snapshot.nodes
      .filter((n) => n.ref.kind.startsWith("acquisition-"))
      .every((n) => n.ref.revision === 9),
  );
  assert.equal(
    snapshot.nodes.find((n) => n.ref.kind === "evidence")!.ref.revision,
    2,
  );
  assert.equal(snapshot.events.length, 6);
  assert(
    snapshot.events
      .filter((e) => e.action !== "acquisition.leased")
      .every((e) => e.actorId === "not recorded"),
  );
  assert(layoutWorkspace(view, snapshot).edges.length > 0);
  const serialized = JSON.stringify(snapshot);
  assert(!serialized.includes("secret-lease-token"));
  assert(!serialized.includes("secret-user-agent"));
});
test("bounded item and attempt windows disclose totals and include actual dependency items", () => {
  const snapshot = projectAcquisition(view, fixture(), "implemented", {
    itemOffset: 0,
    itemLimit: 1,
    attemptOffset: 3,
    attemptLimit: 1,
  });
  const root = snapshot.nodes.find((n) => n.kind === "objective")!,
    details = root.details as {
      windows: {
        displayedItems: number;
        displayedAttempts: number;
        totalItems: number;
        totalAttempts: number;
        nextItemOffset: number;
        nextAttemptOffset: null;
      };
    };
  assert.equal(details.windows.displayedItems, 2);
  assert.equal(details.windows.displayedAttempts, 1);
  assert.equal(details.windows.totalItems, 5);
  assert.equal(details.windows.totalAttempts, 4);
  assert.equal(details.windows.nextItemOffset, 1);
  assert.equal(details.windows.nextAttemptOffset, null);
  assert.equal(snapshot.events.length, 1);
  assert.match(root.summary, /1 of 5/);
  for (const options of [
    { itemOffset: -1 },
    { attemptOffset: 5 },
    { itemLimit: 101 },
    { attemptLimit: 201 },
  ])
    assert.throws(
      () => projectAcquisition(view, fixture(), "tested", options),
      { code: "invalid_window" },
    );
});
test("projection rejects foreign scope, hidden foreign receipts and inconsistent lease/attempt histories", () => {
  assert.throws(() =>
    projectAcquisition({ ...view, tenantId: "other" }, fixture(), "tested"),
  );
  assert.throws(() =>
    projectAcquisition(view, { ...fixture(), revision: 0 }, "tested"),
  );
  const foreign = fixture();
  foreign.state.leases[0]!.receipt = { ...receipt, projectId: "other" };
  assert.throws(() =>
    projectAcquisition(view, foreign, "tested", {
      itemOffset: 4,
      itemLimit: 1,
      attemptOffset: 4,
      attemptLimit: 1,
    }),
  );
  const missing = fixture();
  missing.state.leases = missing.state.leases.slice(1);
  assert.throws(() => projectAcquisition(view, missing, "tested"));
  const mismatch = fixture();
  mismatch.state.leases[2]!.status = "completed";
  assert.throws(() => projectAcquisition(view, mismatch, "tested"));
  const digest = fixture();
  digest.state.collection.attempts[0]!.sha256 = "forged";
  assert.throws(() => projectAcquisition(view, digest, "tested"));
  const reserved = fixture();
  reserved.state.leases[0]!.receipt = { ...receipt, kind: "acquisition-item" };
  assert.throws(() => projectAcquisition(view, reserved, "tested"), {
    code: "reference_collision",
  });
});
test("generated graph/table inspectors keep source identifiers inert and expose the selected exact record", () => {
  const input = fixture();
  const id = "</script><script>window.injected=true</script>";
  input.state.collection.items[4]!.id = id;
  const snapshot = projectAcquisition(view, input, "tested"),
    dom = new JSDOM(renderWorkspace(view, snapshot), {
      runScripts: "dangerously",
    });
  const dialog = dom.window.document.querySelector("dialog")!;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  const button = [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>(
      "button[data-node]",
    ),
  ].find((b) => b.textContent === id)!;
  button.click();
  assert.equal(
    dom.window.document.querySelector("#detail-title")!.textContent,
    id,
  );
  assert.match(
    dom.window.document.querySelector("#detail")!.textContent!,
    /storageRevision/,
  );
  assert.equal(
    (dom.window as unknown as { injected?: boolean }).injected,
    undefined,
  );
  assert(!dom.window.document.querySelector("script[src]"));
  dom.window.close();
});
