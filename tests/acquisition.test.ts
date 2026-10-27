import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createCollection,
  startAcquisition,
  finishAcquisition,
} from "@accountability/discovery-acquisition/collection";
import type {
  ScheduleSnapshot,
  AcquisitionLease,
} from "@accountability/discovery-acquisition/scheduler";
import type { Capture } from "@accountability/discovery-acquisition";
import { projectAcquisition } from "../src/acquisition.ts";
import { renderWorkspace, layoutWorkspace } from "../src/index.ts";
import { hashBytes } from "../src/contracts.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "t",
  projectId: "p",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "research",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const view = { ...c, now: "2026-01-01T00:02:00Z" };
const receipt = {
  tenantId: "t",
  projectId: "p",
  kind: "evidence",
  id: "receipt",
  revision: 2,
};
function fixture(): ScheduleSnapshot {
  let collection = createCollection(c, {
    id: "collection",
    sourcePolicy: {
      tenantId: "t",
      projectId: "p",
      id: "policy",
      allowedHosts: ["records.example"],
      enabled: true,
      expiresAt: "2026-01-02T00:00:00Z",
      maximumBytes: 1024,
      maximumRedirects: 1,
      userAgent: "secret-user-agent",
      accessBasis: "private deployment access basis",
    },
    items: ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      url: "https://records.example/" + id,
      expectedMediaType: "text/plain",
    })),
    refreshAfterMs: 60000,
  });
  const bytes = Buffer.from("Fictional document");
  const capture: Capture = {
    tenantId: "t",
    projectId: "p",
    sourcePolicyId: "policy",
    requestedUrl: collection.items[0]!.url,
    finalUrl: collection.items[0]!.url,
    retrievedAt: c.now,
    status: 200,
    contentType: "text/plain",
    sha256: hashBytes(bytes),
    bytes,
    redirects: [],
    etag: null,
    lastModified: null,
  };
  const leases: AcquisitionLease[] = [];
  for (const [index, item] of collection.items.slice(0, 4).entries()) {
    const id = "attempt-" + index;
    collection = startAcquisition(c, collection, item.id, id);
    const status =
      index < 2 ? "completed" : index === 2 ? "running" : "reconcile";
    if (index === 0)
      collection = finishAcquisition(
        { ...c, now: "2026-01-01T00:00:01Z" },
        collection,
        id,
        { capture, receiptId: receipt.id },
      );
    if (index === 1)
      collection = finishAcquisition(
        { ...c, now: "2026-01-01T00:01:01Z" },
        collection,
        id,
        { failureCode: "lease_expired_unconsumed" },
      );
    leases.push({
      token: "secret-lease-token-" + index,
      attemptId: id,
      itemId: item.id,
      actorId: "worker-" + index,
      actorKind: "service",
      leasedAt: c.now,
      expiresAt: "2026-01-01T00:01:00Z",
      status,
      receipt: index === 0 ? receipt : null,
    });
  }
  return {
    revision: 9,
    state: { schemaVersion: 1, enabled: true, collection, leases },
  };
}
test("acquisition audit preserves global coverage, uncertainty and exact receipt/containing revisions", () => {
  const snapshot = projectAcquisition(view, fixture(), "tested");
  assert.equal(snapshot.visibility, "private");
  assert.deepEqual(snapshot.agents, []);
  const root = snapshot.nodes.find((n) => n.kind === "objective")!;
  assert.match(root.summary, /1 of 5 planned items/);
  assert.match(root.summary, /not incident counts/);
  assert.equal(root.state, "active-with-uncertainty");
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
