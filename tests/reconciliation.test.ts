import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fixture, action, origin, context } from "./reconciliation-fixture.ts";
import { ReconciliationClient } from "../src/reconciliation-client.ts";
import { mountReconciliationControls } from "../src/reconciliation-controls.ts";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
const session = {
  actorId: "owner",
  tenantId: context.tenantId,
  projectId: context.projectId,
  csrfToken: "s".repeat(40),
};
const completion = {
  status: "completed",
  jobId: action.jobId,
  revision: 4,
  outcome: {
    derivative: {
      ...context,
      kind: "processing-private-text",
      id: "a".repeat(64),
      revision: 1,
    },
    sha256: "b".repeat(64),
    receipt: {
      ...context,
      kind: "processing-output-receipt",
      id: "a".repeat(64),
      revision: 1,
    },
  },
};
// Response profiles contain references only, never Context/actor authority.
for (const ref of [completion.outcome.derivative, completion.outcome.receipt]) {
  for (const key of ["actor", "purpose", "requestId", "now"] as const)
    delete (ref as Partial<typeof ref>)[key];
}
test("explicit client finalizes actual pending encrypted output and verifies current proof on replay", async (t) => {
  const f = await fixture(t);
  const r = await f.client.reconcile(action);
  assert.equal(r.status, "completed");
  assert.equal(f.client.pending, null);
  assert.equal((await f.jobs.read(context, "actual")).job.status, "completed");
  assert.deepEqual(
    f.requests.map((r) => r.path),
    ["/processing/session", "/processing/reconcile"],
  );
  f.deny();
  const denied = await f.client.reconcile({
    ...action,
    output: "recover-stored",
  });
  assert.deepEqual(denied, {
    status: "reconciliation-required",
    phase: "output",
  });
  assert.deepEqual(f.client.pending, { ...action, output: "recover-stored" });
});
test("lost actual completion acknowledgement locks immutable action and exact explicit replay obtains fresh CSRF", async (t) => {
  const f = await fixture(t);
  let lose = true;
  const client = new ReconciliationClient(origin, context, async (...args) => {
    const response = await f.transport(...args);
    if (args[1]?.method === "POST" && lose) {
      lose = false;
      throw Error("private diagnostic");
    }
    return response;
  });
  const mutable = { ...action };
  const pending = client.reconcile(mutable);
  mutable.jobId = "foreign";
  await assert.rejects(pending, /outcome_unknown/);
  assert.equal((await f.jobs.read(context, "actual")).job.status, "completed");
  assert.deepEqual(client.pending, action);
  const copy = client.pending!;
  (copy as { jobId: string }).jobId = "changed";
  await assert.rejects(
    client.reconcile({ ...action, output: "recover-stored" }),
    /client_locked/,
  );
  const before = f.requests.length;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.requests.length, before);
  f.rotateCsrf();
  assert.equal((await client.resolvePending()).status, "completed");
  const posts = f.requests.filter((r) => r.body);
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.body, posts[1]!.body);
  assert.notEqual(posts[0]!.csrf, posts[1]!.csrf);
  assert.equal(client.pending, null);
});
test("unknown recovery cannot auto-finalize or switch modes, and identity change cannot replay", async (t) => {
  const f = await fixture(t),
    request = { ...action, output: "recover-stored" as const };
  assert.equal(
    (await f.client.reconcile(request)).status,
    "reconciliation-required",
  );
  assert.equal((await f.jobs.read(context, "actual")).job.status, "consumed");
  await assert.rejects(f.client.reconcile(action), /client_locked/);
  f.switchActor();
  const posts = f.requests.filter((r) => r.body).length;
  await assert.rejects(f.client.resolvePending(), /identity_changed/);
  assert.equal(f.client.closed, true);
  assert.equal(f.requests.filter((r) => r.body).length, posts);
  assert.deepEqual(f.client.pending, request);
});
test("completed response must match exact execution, private reference scope and schema", async () => {
  for (const change of [
    (r: any) => {
      r.jobId = "foreign";
    },
    (r: any) => {
      r.revision = 5;
    },
    (r: any) => {
      r.outcome.receipt.projectId = "foreign";
    },
    (r: any) => {
      r.outcome.derivative.revision = 2;
    },
    (r: any) => {
      r.outcome.sha256 = "no";
    },
    (r: any) => {
      r.sourcePlaintext = "private";
    },
    (r: any) => {
      r.outcome.receipt.id = "c".repeat(64);
    },
  ]) {
    const value = structuredClone(completion);
    change(value);
    const c = new ReconciliationClient(origin, context, async (_u, o) =>
      json(o?.method === "POST" ? value : session),
    );
    await assert.rejects(c.reconcile(action), /invalid_response/);
    assert.deepEqual(c.pending, action);
  }
  const c = new ReconciliationClient(origin, context, async () =>
    json({ ...session, projectId: "foreign" }),
  );
  await assert.rejects(c.reconcile(action));
  assert.equal(c.pending, null);
});
test("late blocked transport/read and hostile response budgets cannot clear pending; signals close", async () => {
  let signal: AbortSignal | undefined;
  for (const behavior of [
    "block-fetch",
    "block-read",
    "bytes",
    "chunks",
    "encoding",
    "invalid-utf8",
    "hang",
  ] as const) {
    let cancelled = false;
    const c = new ReconciliationClient(
      origin,
      context,
      async (_u, o) => {
        if (o?.method !== "POST") return json(session);
        signal = o.signal as AbortSignal;
        if (behavior === "block-fetch") {
          const until = performance.now() + 40;
          while (performance.now() < until) {}
          return json(completion);
        }
        if (behavior === "hang") return new Promise(() => {});
        if (behavior === "encoding")
          return new Response("{}", {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "content-encoding": "gzip",
            },
          });
        let count = 0;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(q) {
                if (behavior === "block-read") {
                  const until = performance.now() + 40;
                  while (performance.now() < until) {}
                  q.enqueue(
                    new TextEncoder().encode(JSON.stringify(completion)),
                  );
                  q.close();
                } else if (behavior === "bytes") {
                  q.enqueue(new Uint8Array(262145));
                  q.close();
                } else if (behavior === "invalid-utf8") {
                  q.enqueue(new Uint8Array([255]));
                  q.close();
                } else if (++count <= 4097) q.enqueue(new Uint8Array());
                else q.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      },
      behavior === "chunks" ? 1000 : 10,
    );
    await assert.rejects(c.reconcile(action));
    assert.deepEqual(c.pending, action);
    assert.equal(signal?.aborted, true);
    if (behavior === "chunks") assert.equal(cancelled, true);
  }
});
async function waitFor(done: () => boolean) {
  const until = Date.now() + 10000;
  while (!done()) {
    if (Date.now() > until) throw Error("test UI deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("mounted exact controls retain unknown fields, deny programmatic replacement, and render actual completion inertly", async (t) => {
  const f = await fixture(t);
  let lose = true;
  const client = new ReconciliationClient(origin, context, async (...args) => {
    const r = await f.transport(...args);
    if (args[1]?.method === "POST" && lose) {
      lose = false;
      throw Error("private");
    }
    return r;
  });
  const dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  t.after(() => dom.window.close());
  const m = mountReconciliationControls(root, client);
  const form = root.querySelector("form")!,
    inputs = root.querySelectorAll("input"),
    mode = root.querySelector("select")!;
  inputs[0]!.value = action.jobId;
  inputs[1]!.value = "3";
  mode.value = action.output;
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await waitFor(() =>
    root.textContent!.includes("original request remains locked"),
  );
  assert.equal(inputs[0]!.disabled, true);
  assert.equal(mode.disabled, true);
  assert.equal(inputs[0]!.value, action.jobId);
  const posts = f.requests.filter((r) => r.body).length;
  inputs[0]!.value = "replacement";
  mode.value = "recover-stored";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  assert.equal(f.requests.filter((r) => r.body).length, posts);
  root.querySelectorAll("button")[1]!.click();
  await waitFor(() => root.textContent!.includes("Completion acknowledged"));
  assert.equal(client.pending, null);
  assert.equal(root.querySelectorAll("script").length, 0);
  assert.equal(
    root.querySelector('[role="status"]')?.getAttribute("aria-live"),
    "polite",
  );
  assert.equal(root.textContent!.includes("hello"), false);
  assert.equal(root.textContent!.includes("s".repeat(40)), false);
  const commands = f.requests.filter((r) => r.body);
  assert.equal(commands[0]!.body, commands[1]!.body);
  m.dispose();
  assert.equal(root.children.length, 0);
});
test("disposal fences late responses and detached UI; invalid origins/requests cannot issue transport", async () => {
  let finish!: (r: Response) => void,
    calls = 0;
  const c = new ReconciliationClient(origin, context, async (_u, o) => {
    calls++;
    if (o?.method !== "POST") return json(session);
    return new Promise((r) => {
      finish = r;
    });
  });
  const dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!,
    m = mountReconciliationControls(root, c);
  const form = root.querySelector("form")!,
    detached = root.querySelector('[role="status"]')!;
  root.querySelectorAll("input")[0]!.value = "actual";
  root.querySelectorAll("input")[1]!.value = "3";
  root.querySelector("select")!.value = "finalize-existing";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await waitFor(() => !!finish);
  const text = detached.textContent;
  m.dispose();
  finish(json(completion));
  await new Promise((r) => setImmediate(r));
  assert.equal(root.children.length, 0);
  assert.equal(detached.textContent, text);
  assert.deepEqual(c.pending, action);
  await assert.rejects(c.resolvePending(), /client_locked/);
  assert.equal(calls, 2);
  dom.window.close();
  assert.throws(
    () => new ReconciliationClient("http://workspace.example", context, fetch),
  );
  let issued = 0;
  const invalid = new ReconciliationClient(origin, context, async () => {
    issued++;
    return json(session);
  });
  await assert.rejects(
    invalid.reconcile({ ...action, output: "execute" as never }),
  );
  assert.equal(issued, 0);
});

test("busy commands, current-session failure and HTTP rejection cannot replace pending authority", async () => {
  let finish!: (r: Response) => void,
    posts = 0,
    rejectedSession = false;
  const c = new ReconciliationClient(origin, context, async (_u, o) => {
    if (o?.method !== "POST")
      return json(
        rejectedSession ? { error: "authentication_required" } : session,
        rejectedSession ? 401 : 200,
      );
    posts++;
    return new Promise((r) => {
      finish = r;
    });
  });
  const first = c.reconcile(action);
  await waitFor(() => !!finish);
  await assert.rejects(c.reconcile(action), /client_locked/);
  await assert.rejects(c.resolvePending(), /client_locked/);
  finish(json({ error: "manager_required" }, 403));
  await assert.rejects(first, /request_rejected/);
  assert.deepEqual(c.pending, action);
  rejectedSession = true;
  await assert.rejects(c.resolvePending(), /session_unavailable/);
  assert.deepEqual(c.pending, action);
  assert.equal(posts, 1);
});
test("captured scope and transport remain fixed, malformed/redirected/private-cache responses retain exact pending", async () => {
  const scope = { tenantId: context.tenantId, projectId: context.projectId };
  let calls = 0;
  const transport: typeof fetch = async (_u, o) => {
    calls++;
    return json(o?.method === "POST" ? completion : session);
  };
  const c = new ReconciliationClient(origin, scope, transport);
  scope.projectId = "mutated";
  assert.equal((await c.reconcile(action)).status, "completed");
  assert.equal(calls, 2);
  for (const bad of [
    () =>
      new Response("{}", {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      }),
    () =>
      new Response("{}", { headers: { "content-type": "application/json" } }),
    () => {
      const r = json(completion);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
    () => {
      const r = json(completion);
      Object.defineProperty(r, "url", {
        value: "https://foreign.example/processing/reconcile",
      });
      return r;
    },
    () =>
      json({ status: "reconciliation-required", phase: "absent-output" }, 503),
  ]) {
    const x = new ReconciliationClient(origin, context, async (_u, o) =>
      o?.method === "POST" ? bad() : json(session),
    );
    await assert.rejects(x.reconcile(action));
    assert.deepEqual(x.pending, action);
  }
});
test("mounted unknown literal job text stays inert, action starts unselected and wrong document origin is refused", async () => {
  const dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  const c = new ReconciliationClient(origin, context, async (_u, o) =>
    json(
      o?.method === "POST"
        ? { status: "reconciliation-required", phase: "inspection" }
        : session,
      o?.method === "POST" ? 503 : 200,
    ),
  );
  const m = mountReconciliationControls(root, c);
  assert.equal(root.querySelector("select")!.value, "");
  assert.equal(root.querySelectorAll("button")[1]!.disabled, true);
  const literal = '<img src=x onerror="throw Error()">';
  root.querySelectorAll("input")[0]!.value = literal;
  root.querySelectorAll("input")[1]!.value = "3";
  root.querySelector("select")!.value = "recover-stored";
  root
    .querySelector("form")!
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await waitFor(() =>
    root.textContent!.includes("Diagnostic phase: inspection"),
  );
  assert.equal(root.querySelectorAll("img,script").length, 0);
  assert(root.querySelector("pre")!.textContent!.includes("<img"));
  assert.deepEqual(c.pending, {
    ...action,
    jobId: literal,
    output: "recover-stored",
  });
  m.dispose();
  dom.window.close();
  const wrong = new JSDOM("<main></main>", { url: "https://foreign.example" });
  assert.throws(
    () =>
      mountReconciliationControls(
        wrong.window.document.querySelector("main")!,
        new ReconciliationClient(origin, context, fetch),
      ),
    /origin_denied/,
  );
  wrong.window.close();
});
