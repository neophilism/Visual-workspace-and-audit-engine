import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fixture } from "./operator-helpers.ts";
import { mountOperatorControls } from "../src/operator-controls.ts";
import { OperatorClient } from "../src/operator-client.ts";
async function settle() {
  await new Promise<void>((r) => setImmediate(r));
}
test("mounted controls save real private drafts and take human control without sending", async () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>", { url: "https://workspace.example" }),
    root = dom.window.document.querySelector("main")!;
  const mounted = mountOperatorControls(root, f.client);
  await mounted.ready;
  const click = (text: string) => {
    const b = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    assert(b);
    b.click();
  };
  click("Record availability");
  await settle();
  assert(root.textContent!.includes("unverified"));
  const body = root.querySelector("textarea")!;
  body.value = "Fictional follow-up saved privately";
  click("Save private draft");
  await settle();
  assert(
    f.state.drafts.some(
      (d) => d.body === "Fictional follow-up saved privately",
    ),
  );
  click("Take human control");
  await settle();
  assert.equal(f.state.mailbox.control, "human");
  assert(
    ![...root.querySelectorAll("button")].some((b) =>
      /send|publish/i.test(b.textContent!),
    ),
  );
  mounted.dispose();
  assert.equal(root.children.length, 0);
  dom.window.close();
});
test("lost acknowledgement keeps text and blocks another edit until explicit exact replay", async () => {
  const f = fixture();
  let lose = true;
  const client = new OperatorClient(
    "https://workspace.example",
    async (i, o) => {
      const r = await f.transport(i, o);
      if (o?.method === "POST" && lose) {
        lose = false;
        throw Error("secret");
      }
      return r;
    },
  );
  const dom = new JSDOM("<main></main>", { url: "https://workspace.example" }),
    root = dom.window.document.querySelector("main")!;
  const m = mountOperatorControls(root, client);
  await m.ready;
  [...root.querySelectorAll("button")]
    .find((b) => b.textContent === "Record availability")!
    .click();
  await settle();
  root.querySelector("textarea")!.value = "Retain my text";
  [...root.querySelectorAll("button")]
    .find((b) => b.textContent === "Save private draft")!
    .click();
  await settle();
  assert.equal(root.querySelector("textarea")!.value, "Retain my text");
  assert(root.textContent!.includes("outcome unknown"));
  assert(
    [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "Save private draft",
    )!.disabled,
  );
  [...root.querySelectorAll("button")]
    .find((b) => b.textContent === "Resolve pending edit")!
    .click();
  await settle();
  assert.equal(client.pending, null);
  const posts = f.requests.filter((r) => r.init.method === "POST");
  assert.equal(posts[0].init.body, posts[1].init.body);
  m.dispose();
  dom.window.close();
});
