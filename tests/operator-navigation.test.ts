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
  const folder = root.querySelector<HTMLSelectElement>(
      'select[aria-label="Mail folder"]',
    )!,
    search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  const click = (name: string) => {
    const button = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === name,
    )!;
    assert(button, name);
    assert(!button.disabled, name + " disabled");
    button.click();
  };
  const choose = (value: string) => {
    folder.value = value;
    folder.dispatchEvent(new dom.window.Event("change"));
  };
  return {
    dom,
    root,
    folder,
    search,
    click,
    choose,
    close() {
      mounted.dispose();
      dom.window.close();
    },
  };
}
test("mounted folders and literal search use actual authorized backend projections without writes", async () => {
  const f = fixture();
  f.state.threads.push({
    ...f.state.threads[0]!,
    id: "archive-item",
    subject: "Archived fictional record",
    folder: "archive",
  });
  const s = await screen(f.client);
  s.choose("archive");
  await settle();
  assert.equal(s.folder.value, "archive");
  assert(s.root.textContent!.includes("1-1 of 1"));
  s.search.value = "Archived";
  s.search.dispatchEvent(
    new s.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await settle();
  let url = new URL(
    f.requests.filter((r) => r.url.includes("/operator/mail?")).at(-1)!.url,
  );
  assert.equal(url.searchParams.get("view"), "archive");
  assert.equal(url.searchParams.get("query"), "Archived");
  assert.equal(url.searchParams.get("offset"), "0");
  s.click("Clear search");
  await settle();
  assert.equal(s.search.value, "");
  const query = "& <img src=x onerror=window.injected=true>";
  s.search.value = query;
  s.click("Search");
  await settle();
  url = new URL(
    f.requests.filter((r) => r.url.includes("/operator/mail?")).at(-1)!.url,
  );
  assert.equal(url.searchParams.get("query"), query);
  assert.equal(s.root.querySelectorAll("img").length, 0);
  assert(s.root.textContent!.includes(query));
  assert.equal(f.requests.filter((r) => r.init.method === "POST").length, 0);
  s.close();
});
test("filtered pagination retains query and revision and changed mailbox leaves the displayed page intact", async () => {
  const f = fixture();
  for (let i = 0; i < 55; i++)
    f.state.threads.push({
      ...f.state.threads[0]!,
      id: "page-" + i,
      subject: "Needle " + i,
      folder: "archive",
    });
  const s = await screen(f.client);
  s.choose("archive");
  await settle();
  s.search.value = "needle";
  s.click("Search");
  await settle();
  s.click("Next page");
  await settle();
  assert(s.root.textContent!.includes("51-55 of 55"));
  let url = new URL(
    f.requests.filter((r) => r.url.includes("/operator/mail?")).at(-1)!.url,
  );
  assert.equal(url.searchParams.get("query"), "needle");
  assert.equal(url.searchParams.get("view"), "archive");
  f.state.revision++;
  s.click("Previous page");
  await settle();
  assert(s.root.textContent!.includes("mailbox_changed"));
  assert(s.root.textContent!.includes("51-55 of 55"));
  s.click("Clear search");
  await settle();
  assert(s.root.textContent!.includes("1-50 of 55"));
  url = new URL(
    f.requests.filter((r) => r.url.includes("/operator/mail?")).at(-1)!.url,
  );
  assert.equal(url.searchParams.get("offset"), "0");
  s.close();
});
test("failed folder reads retain the committed filter, list and selected conversation", async () => {
  const f = fixture(),
    client = new OperatorClient("https://workspace.example", async (i, o) => {
      if (new URL(String(i)).searchParams.get("view") === "archive")
        throw Error("private-provider-secret");
      return f.transport(i, o);
    });
  const s = await screen(client);
  s.click("Record availability");
  await settle();
  const before = s.root.querySelector(
    'section[aria-label="Conversations"]',
  )!.textContent;
  s.choose("archive");
  await settle();
  assert.equal(s.folder.value, "all");
  assert.equal(
    s.root.querySelector('section[aria-label="Conversations"]')!.textContent,
    before,
  );
  assert(s.root.querySelector("textarea"));
  assert(!s.root.textContent!.includes("private-provider-secret"));
  s.close();
});
test("unsaved editor text blocks filter reads until save or explicit close", async () => {
  const f = fixture(),
    s = await screen(f.client);
  s.click("Record availability");
  await settle();
  s.root.querySelector("textarea")!.value = "Retain this unsaved draft";
  const count = f.requests.length;
  s.choose("archive");
  await settle();
  assert(s.root.textContent!.includes("unsaved_draft"));
  assert.equal(f.requests.length, count);
  assert.equal(s.folder.value, "all");
  assert.equal(
    s.root.querySelector("textarea")!.value,
    "Retain this unsaved draft",
  );
  s.click("Close conversation");
  await settle();
  assert.equal(s.root.querySelector("textarea"), null);
  s.choose("archive");
  await settle();
  assert.equal(s.folder.value, "archive");
  s.close();
});
test("uncertain edit locks folder/search navigation without issuing reads", async () => {
  const f = fixture();
  let lose = true;
  const client = new OperatorClient(
    "https://workspace.example",
    async (i, o) => {
      const response = await f.transport(i, o);
      if (o?.method === "POST" && lose) {
        lose = false;
        throw Error("lost");
      }
      return response;
    },
  );
  const s = await screen(client);
  s.click("Record availability");
  await settle();
  s.root.querySelector("textarea")!.value = "Original pending text";
  s.click("Save private draft");
  await settle();
  assert(s.folder.disabled && s.search.disabled);
  const count = f.requests.length;
  s.choose("archive");
  await settle();
  assert.equal(f.requests.length, count);
  assert.equal(s.folder.value, "all");
  assert.equal(
    s.root.querySelector("textarea")!.value,
    "Original pending text",
  );
  s.click("Resolve pending edit");
  await settle();
  assert.equal(client.pending, null);
  assert(!s.folder.disabled);
  s.close();
});
test("partial composition locks filter controls until explicit cancellation and does not claim draft success", async () => {
  const f = fixture(),
    client = new OperatorClient("https://workspace.example", async (i, o) => {
      if (
        o?.method === "POST" &&
        JSON.parse(String(o.body)).command.type === "createDraft"
      )
        return Response.json(
          { error: { code: "permission_denied" } },
          { status: 403 },
        );
      return f.transport(i, o);
    });
  const s = await screen(client);
  s.click("New conversation");
  await settle();
  const detail = s.root.querySelector(
      'section[aria-label="Selected conversation"]',
    )!,
    inputs = detail.querySelectorAll("input");
  inputs[0]!.value = "fictional@records.example";
  inputs[1]!.value = "Partial private draft";
  detail.querySelector("textarea")!.value = "Preserve this body";
  s.click("Create conversation and draft");
  await settle();
  assert(s.folder.disabled && s.search.disabled);
  assert(s.root.textContent!.includes("draft remains incomplete"));
  const count = f.requests.length;
  s.choose("archive");
  await settle();
  assert.equal(f.requests.length, count);
  assert.equal(s.folder.value, "all");
  s.click("Cancel composition");
  await settle();
  assert(!s.folder.disabled && !s.search.disabled);
  assert(f.state.threads.some((t) => t.subject === "Partial private draft"));
  s.close();
});
test("mark-read refreshes actual unread membership rather than leaving a stale filtered list", async () => {
  const f = fixture();
  f.state.threads[0]!.read = false;
  const s = await screen(f.client);
  s.choose("unread");
  await settle();
  s.click("Record availability");
  await settle();
  s.click("Mark read");
  await settle();
  assert(
    s.root
      .querySelector('section[aria-label="Conversations"]')!
      .textContent!.includes("0 total"),
  );
  assert(f.state.threads[0]!.read);
  assert.equal(s.folder.value, "unread");
  s.close();
});
test("disposing a pending read prevents late writes even to detached filter controls", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const client = new OperatorClient(
    "https://workspace.example",
    async (i, o) => {
      const result = await f.transport(i, o);
      if (String(i).includes("/operator/mail?")) {
        started();
        return new Promise<Response>((r) => {
          release = () => r(result);
        });
      }
      return result;
    },
  );
  const dom = new JSDOM("<main></main>", { url: "https://workspace.example" }),
    root = dom.window.document.querySelector("main")!,
    mounted = mountOperatorControls(root, client);
  await entered;
  const folder = root.querySelector("select")!,
    descriptor = Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value",
    )!;
  let writes = 0;
  Object.defineProperty(folder, "value", {
    get: () => descriptor.get!.call(folder),
    set: (value) => {
      writes++;
      descriptor.set!.call(folder, value);
    },
  });
  mounted.dispose();
  release();
  await mounted.ready;
  assert.equal(writes, 0);
  assert.equal(root.children.length, 0);
  dom.window.close();
});
