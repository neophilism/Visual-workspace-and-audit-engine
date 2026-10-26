import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createAlphaCorrespondenceFixture,
  transitionCorrespondence,
} from "@accountability/correspondence";
import type { CorrespondenceCommand } from "@accountability/correspondence";
import { projectInbox, renderInbox } from "../src/inbox.ts";
function fixture() {
  const f = createAlphaCorrespondenceFixture();
  return { state: f.state, c: f.steps[0]!.context };
}
test("private inbox reuses human scope/read checks and excludes authority and credential fields", () => {
  const { state, c } = fixture();
  const s = projectInbox(c, state),
    encoded = JSON.stringify(s);
  assert.equal(s.visibility, "private");
  assert.equal(s.revision, state.revision);
  assert(!encoded.includes("alpha-credential-handle"));
  assert(!encoded.includes("alpha-grant"));
  assert(!encoded.includes("alpha-account"));
  assert(!encoded.includes("issuedBy"));
  assert(
    s.threads[0]!.messages.filter((m) => m.direction === "inbound").every(
      (m) => m.verification === "unverified" && !m.policyAuthority,
    ),
  );
  for (const context of [
    { ...c, tenantId: "other" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, actor: { ...c.actor, roles: [] } },
  ])
    assert.throws(() => renderInbox(context, state));
  const foreign = structuredClone(state);
  foreign.messages[0] = {...foreign.messages[0]!, projectId: "other"};
  assert.throws(() => projectInbox(c, foreign));
});
test("folder switching full-text search and conversation review use actual upstream semantics without mutations", () => {
  let { state, c } = fixture();
  const commands: CorrespondenceCommand[] = [
    {
      type: "createThread",
      inputId: "archived",
      threadId: "archived",
      recipient: "archive@alpha.example",
      subject: "Archive question",
    },
    {
      type: "createDraft",
      inputId: "draft",
      threadId: "archived",
      draftId: "saved-draft",
      content: {
        kind: "human",
        subject: "Archive question",
        body: "Fictional unique amber record",
      },
    },
    {
      type: "setThreadFlags",
      inputId: "archive",
      threadId: "archived",
      folder: "archive",
      starred: true,
    },
  ];
  for (const command of commands)
    state = transitionCorrespondence(state, c, command).state;
  const before = JSON.stringify(state),
    dom = new JSDOM(renderInbox(c, state), { runScripts: "dangerously" }),
    d = dom.window.document;
  assert.equal(d.querySelectorAll("[data-thread]").length, 1);
  (d.querySelector('[data-view="archive"]') as HTMLElement).click();
  assert.equal(d.querySelectorAll("[data-thread]").length, 1);
  (d.querySelector("[data-thread]") as HTMLElement).click();
  assert.match(d.querySelector("#conversation")!.textContent!, /unique amber/);
  assert.match(d.querySelector("#conversation")!.textContent!, /Draft:/);
  const search = d.querySelector("#search") as HTMLInputElement;
  search.value = "AMBER";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(d.querySelectorAll("[data-thread]").length, 1);
  search.value = "does-not-exist";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(d.querySelectorAll("[data-thread]").length, 0);
  assert.match(
    d.querySelector("#conversation")!.textContent!,
    /No conversations match/,
  );
  assert.equal(JSON.stringify(state), before);
  dom.window.close();
});
test("untrusted message text is inert and readable while reply uncertainty remains explicit", () => {
  const { state, c } = fixture(),
    attack =
      '</script><script>window.injected=true</script><img src="https://evil.example/track">';
  state.messages.find((m) => m.direction === "inbound")!.body = attack;
  const dom = new JSDOM(renderInbox(c, state), { runScripts: "dangerously" }),
    d = dom.window.document;
  (d.querySelector("[data-thread]") as HTMLElement).click();
  assert(d.querySelector("#conversation")!.textContent!.includes(attack));
  assert.match(
    d.querySelector("#conversation")!.textContent!,
    /unverified.*no policy authority/,
  );
  assert.equal((dom.window as any).injected, undefined);
  assert.equal(d.querySelectorAll("img,iframe,a[href],form").length, 0);
  assert.match(
    d
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!,
    /connect-src 'none'/,
  );
  assert(
    ![...d.querySelectorAll("button")].some((b) =>
      /send|publish|resume|take over/i.test(b.textContent ?? ""),
    ),
  );
  dom.window.close();
});
test("snapshot includes all authorized pages and rejects duplicate oversized or over-budget projections", () => {
  const { state, c } = fixture();
  for (let i = 0; i < 105; i++)
    state.threads.push({
      ...state.threads[0]!,
      id: "extra-" + i,
      subject: "Fictional extra " + i,
    });
  assert.equal(projectInbox(c, state).membership.inbox!.length, 106);
  const duplicate = structuredClone(state);
  duplicate.threads.push({ ...duplicate.threads[0]! });
  assert.throws(() => projectInbox(c, duplicate));
  const oversized = structuredClone(state);
  while (oversized.threads.length < 501)
    oversized.threads.push({
      ...oversized.threads[0]!,
      id: "limit-" + oversized.threads.length,
    });
  assert.throws(() => projectInbox(c, oversized), {
    code: "projection_too_large",
  });
  const body = fixture();
  body.state.messages[0]!.body = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => projectInbox(body.c, body.state), {
    code: "projection_too_large",
  });
});
test("real uncertain handoff is displayed for reconciliation without exposing its command", () => {
  const f = createAlphaCorrespondenceFixture();
  let state = f.initial;
  const handoff = f.steps.find((s) => s.command.type === "handoff")!;
  for (const step of f.steps) {
    state = transitionCorrespondence(state, step.context, step.command).state;
    if (step === handoff) break;
  }
  const intent = state.intents[0]!;
  state = transitionCorrespondence(state, handoff.context, {
    type: "markUncertain",
    inputId: "uncertain-view",
    intentId: intent.id,
    handoffId: intent.handoff!.id,
    reason: "timeout",
  }).state;
  const dom = new JSDOM(renderInbox(f.steps[0]!.context, state), {
    runScripts: "dangerously",
  });
  (dom.window.document.querySelector('[data-view="all"]') as HTMLElement).click();
  (dom.window.document.querySelector("[data-thread]") as HTMLElement).click();
  assert.match(
    dom.window.document.querySelector("#conversation")!.textContent!,
    /uncertain.*reconcile before another attempt/,
  );
  assert(
    !JSON.stringify(projectInbox(f.steps[0]!.context, state)).includes(
      "commandDigest",
    ),
  );
  dom.window.close();
});
