import test from "node:test";
import { fixture } from "./operator-helpers.ts";
import assert from "node:assert/strict";
import {
  createAlphaCorrespondenceFixture,
  transitionCorrespondence,
} from "@accountability/correspondence";
import { createOperatorHandler } from "@accountability/correspondence/operator";
import { OperatorClient } from "../src/operator-client.ts";

test("client uses actual private handler session CSRF and human takeover protocol", async () => {
  const f = fixture(),
    s = await f.client.session();
  const r = await f.client.submit(s.revision, {
    type: "setControl",
    inputId: "client-takeover",
    mode: "human",
  });
  assert.equal(f.state.mailbox.control, "human");
  assert.equal(r.revision, f.state.revision);
  assert.equal(f.client.pending, null);
  const req = f.requests.find((r) => r.init.method === "POST");
  assert.equal(req.init.credentials, "same-origin");
  assert.equal(req.init.redirect, "error");
  assert.equal(req.init.headers["x-csrf-token"], "c".repeat(43));
  assert(!req.init.body.includes("actor"));
});
test("lost acknowledgement blocks new edits and explicit reconciliation replays identical command", async () => {
  const f = fixture();
  let lose = true;
  const client = new OperatorClient(
    "https://workspace.example",
    async (i, o) => {
      const response = await f.transport(i, o);
      if (o?.method === "POST" && lose) {
        lose = false;
        throw Error("secret transport detail");
      }
      return response;
    },
  );
  const s = await client.session(),
    command = {
      type: "setControl" as const,
      inputId: "lost-client",
      mode: "human" as const,
    };
  await assert.rejects(
    client.submit(s.revision, command),
    (e: any) => e.code === "outcome_unknown" && !e.message.includes("secret"),
  );
  assert.equal(f.requests.filter((r) => r.init.method === "POST").length, 1);
  await assert.rejects(
    client.submit(s.revision, command),
    (e: any) => e.code === "edit_pending",
  );
  const result = await client.retryPending();
  assert.equal(result.duplicate, true);
  const posts = f.requests.filter((r) => r.init.method === "POST");
  assert.equal(posts[0].init.body, posts[1].init.body);
  assert.equal(client.pending, null);
});
test("outbound commands configuration malformed sessions and timeout fail closed", async () => {
  const f = fixture();
  await assert.rejects(
    f.client.submit(0, { type: "handoff" } as any),
    (e: any) => e.code === "command_denied",
  );
  await assert.rejects(
    f.client.submit(0, { type: "setControl", mode: "autonomous" } as any),
    (e: any) => e.code === "command_denied",
  );
  assert.throws(
    () => new OperatorClient("http://workspace.example", f.transport),
  );
  const malformed = new OperatorClient("https://workspace.example", async () =>
    Response.json({ csrfToken: "bad" }),
  );
  await assert.rejects(
    malformed.session(),
    (e: any) => e.code === "invalid_response",
  );
  const stalled = new OperatorClient(
    "https://workspace.example",
    async () => new Promise(() => {}),
    10,
  );
  await assert.rejects(
    stalled.session(),
    (e: any) => e.code === "outcome_unknown",
  );
});

test("stale viewed revisions reject without automatic recomputation or retry", async () => {
  const f = fixture(),
    old = await f.client.session();
  await f.client.submit(old.revision, {
    type: "setControl",
    inputId: "advance",
    mode: "human",
  });
  const count = f.requests.length;
  await assert.rejects(
    f.client.submit(old.revision, {
      type: "setControl",
      inputId: "stale",
      mode: "human",
    }),
    (e: any) => e.code === "revision_conflict",
  );
  assert.equal(f.client.pending, null);
  assert.equal(
    f.requests.slice(count).filter((r) => r.init.method === "POST").length,
    1,
  );
});
