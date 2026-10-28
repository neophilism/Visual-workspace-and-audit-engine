import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scoped } from "@accountability/evidence/database";
import { ParticipantClient } from "@accountability/consent-rights/participant-client";
import { createParticipantHandler } from "@accountability/consent-rights/participant-http";
import { setup, participant, manager, input } from "./participant-fixture.ts";
import { mountParticipantControls } from "../src/participant-controls.ts";
const origin = "https://private.example";
const csrf = "s".repeat(40);
const scope = { tenantId: manager.tenantId, projectId: manager.projectId };
async function fixture(t: test.TestContext) {
  const f = await setup(t);
  const dom = new JSDOM("<main></main>", { url: origin });
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector("main")!;
  const requests: { path: string; body: string | null; csrf: string | null }[] =
    [];
  let lose = false,
    token = csrf,
    identity = participant;
  let hold: Promise<void> | undefined;
  const handler = createParticipantHandler(
    f.registry,
    { authenticate: async () => ({ context: identity, csrfToken: token }) },
    { ...scope, origin },
  );
  const client = new ParticipantClient(origin, scope, async (url, init) => {
    const req = new Request(String(url), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
    });
    const path = new URL(req.url).pathname;
    requests.push({
      path,
      body: init?.body ? String(init.body) : null,
      csrf: req.headers.get("x-csrf-token"),
    });
    const r = await handler(req);
    if (hold && path === "/participant/offer") await hold;
    if (lose && init?.method === "POST") {
      lose = false;
      throw Error("private diagnostic");
    }
    return r;
  });
  const ui = mountParticipantControls(root, client, "offer");
  t.after(() => ui.dispose());
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
  const checkbox = () =>
    root.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  const click = async (text: string) => {
    button(text).click();
    const until = performance.now() + 5000;
    // The client/DOM signal is controls re-enabled after an explicit command/read settles.
    while (
      button("Review current offer").disabled &&
      button("Resolve exact pending request").disabled &&
      !root
        .querySelector("[role=status]")
        ?.textContent?.includes("Client closed")
    ) {
      assert.ok(performance.now() < until, "UI did not settle");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const acknowledge = () => {
    checkbox().checked = true;
    checkbox().dispatchEvent(new dom.window.Event("change"));
  };
  return {
    ...f,
    root,
    dom,
    client,
    ui,
    requests,
    button,
    checkbox,
    click,
    acknowledge,
    loseNext: () => {
      lose = true;
    },
    rotate: () => {
      token = "n".repeat(40);
    },
    switchActor: () => {
      identity = {
        ...participant,
        actor: { ...participant.actor, id: "other-person" },
      };
    },
    delayReview: (p: Promise<void>) => {
      hold = p;
    },
  };
}

test("mounted participant controls make no automatic requests and require exact inert review plus explicit acknowledgement", async (t) => {
  const f = await fixture(t);
  assert.equal(f.requests.length, 0);
  assert.equal(f.checkbox().checked, false);
  assert.equal(f.button("Accept reviewed terms").disabled, true);
  assert.equal(f.button("Decline reviewed offer").disabled, true);
  assert.equal(f.button("Withdraw reviewed consent").disabled, true);
  // A programmatic click bypassing native disabled handling is still guarded.
  f.button("Accept reviewed terms").dispatchEvent(
    new f.dom.window.Event("click"),
  );
  assert.equal(f.requests.length, 0);
  await f.click("Review current offer");
  assert.ok(f.root.textContent?.includes(input.disclosure));
  assert.ok(f.root.textContent?.includes(input.terms.resource.digest));
  assert.ok(f.root.textContent?.includes(input.terms.evidence.id));
  assert.equal(f.button("Accept reviewed terms").disabled, true);
  f.acknowledge();
  assert.equal(f.button("Accept reviewed terms").disabled, false);
  await f.click("Accept reviewed terms");
  assert.equal(f.requests.filter((r) => r.body).length, 1);
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /Historical accepted/,
  );
  assert.equal(f.checkbox().checked, false);
  assert.equal(f.button("Withdraw reviewed consent").disabled, true);
  await f.click("Review current offer");
  assert.equal(f.button("Withdraw reviewed consent").disabled, false);
  await f.click("Withdraw reviewed consent");
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /Withdrawal acknowledged/,
  );
  await f.click("Review current offer");
  assert.match(f.root.textContent!, /withdrawal is recorded/);
  assert.equal(f.button("Withdraw reviewed consent").disabled, true);
  await scoped(f.db, manager, async (tx) =>
    assert.equal((await tx.list("consent")).length, 1),
  );
});

test("lost actual response acknowledgement locks all decisions and explicit identical replay preserves current withdrawal", async (t) => {
  const f = await fixture(t);
  await f.click("Review current offer");
  f.acknowledge();
  f.loseNext();
  await f.click("Accept reviewed terms");
  assert.ok(f.client.pending);
  assert.equal(f.button("Review current offer").disabled, true);
  assert.equal(f.button("Decline reviewed offer").disabled, true);
  assert.equal(f.checkbox().disabled, true);
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /Outcome unknown or request rejected/,
  );
  const count = f.requests.length;
  f.button("Decline reviewed offer").dispatchEvent(
    new f.dom.window.Event("click"),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(f.requests.length, count);
  const review = await f.registry.reviewOffer(participant, "offer");
  await f.registry.withdraw(
    participant,
    "consent",
    review.consent!.ref.id,
    1,
    "external-withdraw",
  );
  f.rotate();
  await f.click("Resolve exact pending request");
  const writes = f.requests.filter((r) => r.body);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.body, writes[1]!.body);
  assert.notEqual(writes[0]!.csrf, writes[1]!.csrf);
  assert.equal(f.client.pending, null);
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /Historical accepted/,
  );
  await f.click("Review current offer");
  assert.match(f.root.textContent!, /withdrawal is recorded/);
  assert.equal(f.button("Withdraw reviewed consent").disabled, true);
});

test("decline needs no acknowledgement; stale cancelled offer is a locked rejected request rather than implicit acceptance", async (t) => {
  const f = await fixture(t);
  await f.click("Review current offer");
  assert.equal(f.button("Decline reviewed offer").disabled, false);
  await f.click("Decline reviewed offer");
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /Historical declined/,
  );
  assert.equal(
    (await f.registry.reviewOffer(participant, "offer")).consent,
    null,
  );
  await f.registry.createOffer(manager, { ...input, id: "cancelled" }, "new");
  f.ui.dispose();
  const client = new ParticipantClient(origin, scope, async (url, init) =>
    createParticipantHandler(
      f.registry,
      { authenticate: async () => ({ context: participant, csrfToken: csrf }) },
      { ...scope, origin },
    )(
      new Request(String(url), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
      }),
    ),
  );
  const ui = mountParticipantControls(f.root, client, "cancelled");
  t.after(() => ui.dispose());
  const wait = async () => {
    const until = performance.now() + 5000;
    while (
      f.button("Review current offer").disabled &&
      f.button("Resolve exact pending request").disabled
    ) {
      assert.ok(performance.now() < until);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  f.button("Review current offer").click();
  await wait();
  await f.registry.cancelOffer(manager, "cancelled", 1, "cancel");
  f.acknowledge();
  f.button("Accept reviewed terms").click();
  await wait();
  assert.ok(client.pending);
  assert.equal(
    (await f.registry.reviewOffer(participant, "cancelled")).offer.status,
    "cancelled",
  );
});

test("malicious disclosure stays literal and exact; foreign-origin mounting and pending-offer mismatch fail before requests", async (t) => {
  const f = await fixture(t);
  await f.registry.createOffer(
    manager,
    {
      ...input,
      id: "markup",
      disclosure:
        "<script>globalThis.injected=true</script><img src=x onerror=alert(1)> & literal",
    },
    "markup",
  );
  f.ui.dispose();
  const client = new ParticipantClient(origin, scope, async (url, init) =>
    createParticipantHandler(
      f.registry,
      { authenticate: async () => ({ context: participant, csrfToken: csrf }) },
      { ...scope, origin },
    )(
      new Request(String(url), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
      }),
    ),
  );
  const ui = mountParticipantControls(f.root, client, "markup");
  t.after(() => ui.dispose());
  await f.click("Review current offer");
  assert.ok(
    f.root.textContent?.includes("<script>globalThis.injected=true</script>"),
  );
  assert.equal(f.root.querySelector("script,img"), null);
  assert.equal(f.root.querySelectorAll("label input[type=checkbox]").length, 1);
  const foreign = new JSDOM("<main></main>", {
    url: "https://foreign.example",
  });
  t.after(() => foreign.window.close());
  assert.throws(
    () =>
      mountParticipantControls(
        foreign.window.document.querySelector("main")!,
        client,
        "markup",
      ),
    /origin_denied/,
  );
  // Use actual failed acknowledgement to obtain immutable pending state on the original client.
  const other = await fixture(t);
  await other.click("Review current offer");
  other.acknowledge();
  other.loseNext();
  await other.click("Accept reviewed terms");
  assert.throws(
    () => mountParticipantControls(f.root, other.client, "wrong"),
    /pending_offer_mismatch/,
  );
});

test("identity change closes pending controls and disposal fences detached nodes and late actual review", async (t) => {
  const f = await fixture(t);
  await f.click("Review current offer");
  f.acknowledge();
  f.loseNext();
  await f.click("Accept reviewed terms");
  f.switchActor();
  await f.click("Resolve exact pending request");
  assert.equal(f.client.closed, true);
  assert.ok(f.client.pending);
  assert.match(
    f.root.querySelector("[role=status]")!.textContent!,
    /identity changed/,
  );
  const count = f.requests.length,
    detached = f.button("Resolve exact pending request");
  f.ui.dispose();
  detached.dispatchEvent(new f.dom.window.Event("click"));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.requests.length, count);
  assert.equal(f.root.childNodes.length, 0);
  const delayed = await fixture(t);
  let release!: () => void;
  delayed.delayReview(
    new Promise((r) => {
      release = r;
    }),
  );
  delayed.button("Review current offer").click();
  const until = performance.now() + 5000;
  while (!delayed.requests.some((r) => r.path === "/participant/offer")) {
    assert.ok(performance.now() < until);
    await new Promise((r) => setTimeout(r, 5));
  }
  const checkbox = delayed.checkbox();
  delayed.ui.dispose();
  release();
  await new Promise((r) => setTimeout(r, 20));
  checkbox.checked = true;
  checkbox.dispatchEvent(new delayed.dom.window.Event("change"));
  assert.equal(delayed.root.childNodes.length, 0);
  assert.equal(delayed.requests.filter((r) => r.body).length, 0);
});
