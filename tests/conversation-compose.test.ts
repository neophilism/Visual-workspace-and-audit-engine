import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fixture } from "./operator-helpers.ts";
import { OperatorClient } from "../src/operator-client.ts";
import { mountOperatorControls } from "../src/operator-controls.ts";
const settle = () => new Promise<void>((r) => setImmediate(r));
async function screen(client: OperatorClient) {
  const dom = new JSDOM("<main></main>", { url: "https://workspace.example" }),
    root = dom.window.document.querySelector("main")!;
  const mounted = mountOperatorControls(root, client);
  await mounted.ready;
  const click = (name: string) => {
    const b = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === name,
    );
    assert(b, name);
    assert(!b.disabled, name + " disabled");
    b.click();
  };
  const fill = async () => {
    click("New conversation");
    await settle();
    const inputs = root
      .querySelector('section[aria-label="Selected conversation"]')!
      .querySelectorAll("input");
    inputs[0]!.value = "fictional@archive.example";
    inputs[1]!.value = "Fictional new conversation";
    root.querySelector("textarea")!.value = "Private draft body";
  };
  return {
    dom,
    root,
    click,
    fill,
    close() {
      mounted.dispose();
      dom.window.close();
    },
  };
}
test("pagination exposes later conversations and rejects stale page revisions", async () => {
  const f = fixture();
  for (let i = 0; i < 55; i++)
    f.state.threads.push({
      ...f.state.threads[0]!,
      id: "extra-" + i,
      subject: "Fictional " + i,
    });
  const s = await screen(f.client);
  s.click("Next page");
  await settle();
  assert(s.root.textContent!.includes("51-56 of 56"));
  s.click("Previous page");
  await settle();
  assert(s.root.textContent!.includes("1-50 of 56"));
  f.state.revision++;
  s.click("Next page");
  await settle();
  assert(s.root.textContent!.includes("mailbox_changed"));
  assert(s.root.textContent!.includes("1-50 of 56"));
  s.close();
});
test("new conversation creates an exact private draft and never queues sending", async () => {
  const f = fixture(),
    s = await screen(f.client);
  await s.fill();
  s.click("Create conversation and draft");
  await settle();
  const thread = f.state.threads.find(
    (t) => t.subject === "Fictional new conversation",
  )!;
  assert(thread);
  assert(
    f.state.drafts.some(
      (d) =>
        d.threadId === thread.id &&
        d.body === "Private draft body" &&
        d.status === "draft",
    ),
  );
  assert.equal(f.state.intents.length, 1);
  assert(s.root.textContent!.includes("conversation and draft created"));
  s.close();
});
for (const phase of ["createThread", "createDraft"])
  test(
    "lost " +
      phase +
      " acknowledgement reconciles without duplicate or automatic next-stage work",
    async () => {
      const f = fixture();
      let lose = true;
      const c = new OperatorClient(
        "https://workspace.example",
        async (i, o) => {
          const r = await f.transport(i, o);
          if (
            o?.method === "POST" &&
            JSON.parse(String(o.body)).command.type === phase &&
            lose
          ) {
            lose = false;
            throw Error("lost private response");
          }
          return r;
        },
      );
      const s = await screen(c);
      await s.fill();
      s.click("Create conversation and draft");
      await settle();
      assert(c.pending);
      assert.equal(
        s.root.querySelector("textarea")!.value,
        "Private draft body",
      );
      assert.equal(f.state.threads.length, 2);
      s.click("Resolve pending edit");
      await settle();
      assert.equal(c.pending, null);
      if (phase === "createThread") {
        assert.equal(f.state.drafts.length, 1);
        s.click("Create conversation and draft");
        await settle();
      }
      assert.equal(f.state.threads.length, 2);
      assert.equal(f.state.drafts.length, 2);
      const posts = f.requests
        .filter((r) => r.init.method === "POST")
        .map((r) => r.init.body);
      const relevant = posts.filter(
        (s) => JSON.parse(s).command.type === phase,
      );
      assert.equal(relevant[0], relevant[1]);
      s.close();
    },
  );
test("definite draft rejection preserves the existing conversation and does not imply rollback", async () => {
  const f = fixture();
  const c = new OperatorClient("https://workspace.example", async (i, o) =>
    o?.method === "POST" &&
    JSON.parse(String(o.body)).command.type === "createDraft"
      ? Response.json({ error: { code: "permission_denied" } }, { status: 403 })
      : f.transport(i, o),
  );
  const s = await screen(c);
  await s.fill();
  s.click("Create conversation and draft");
  await settle();
  assert.equal(f.state.threads.length, 2);
  assert.equal(f.state.drafts.length, 1);
  assert(
    s.root.textContent!.includes(
      "Conversation exists; draft remains incomplete",
    ),
  );
  assert(
    [...s.root.querySelectorAll("button")].find(
      (b) => b.textContent === "New conversation",
    )!.disabled,
  );
  assert.equal(s.root.querySelector("textarea")!.value, "Private draft body");
  s.click("Cancel composition");
  await settle();
  assert.equal(f.state.threads.length, 2);
  assert(s.root.textContent!.includes("Conversation remains"));
  s.close();
});
