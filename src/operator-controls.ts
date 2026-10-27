import { OperatorClient, OperatorClientError } from "./operator-client.ts";
/** Mount only in an authenticated same-origin host. This component has no sending controls. */
export function mountOperatorControls(
  root: HTMLElement,
  client: OperatorClient,
) {
  const d = root.ownerDocument;
  if (d.defaultView?.location.origin !== client.origin)
    throw new OperatorClientError("origin_mismatch");
  let disposed = false,
    busy = false,
    revision = 0,
    selected: string | null = null;
  let pageOffset = 0,
    activeView = "all",
    activeQuery = "";
  let unsaved = () => false;
  let composition: null | {
    recipient: string;
    subject: string;
    body: string;
    threadId: string;
    draftId: string;
    threadInputId: string;
    draftInputId: string;
    phase: "thread" | "draft";
    revision: number;
  } = null;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = d.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const heading = el("h2", "Private correspondence"),
    status = el("p"),
    list = el("section"),
    detail = el("section"),
    toolbar = el("div"),
    navigation = el("div"),
    folder = el("select"),
    search = el("input");
  navigation.setAttribute("aria-label", "Mail navigation");
  navigation.setAttribute("role", "navigation");
  folder.setAttribute("aria-label", "Mail folder");
  search.type = "search";
  search.maxLength = 200;
  search.setAttribute("aria-label", "Search conversations");
  for (const [value, label] of [
    ["all", "All mail"],
    ["inbox", "Inbox"],
    ["archive", "Archive"],
    ["drafts", "Drafts"],
    ["unread", "Unread"],
    ["starred", "Starred"],
    ["sent", "Sent"],
    ["trash", "Trash"],
    ["spam", "Spam"],
  ]) {
    const option = el("option", label);
    option.value = value!;
    folder.append(option);
  }
  folder.value = activeView;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  list.setAttribute("aria-label", "Conversations");
  detail.setAttribute("aria-label", "Selected conversation");
  function button(
    label: string,
    action: () => Promise<string | void>,
    reconcile = false,
  ) {
    const b = el("button", label);
    b.type = "button";
    b.dataset.reconcile = String(reconcile);
    b.dataset.compose = String(
      ["Create conversation and draft", "Cancel composition"].includes(label),
    );
    b.onclick = () => {
      void run(action);
    };
    return b;
  }
  function lock() {
    folder.disabled = search.disabled =
      busy || !!client.pending || !!composition;
    root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled =
        busy ||
        (b.dataset.reconcile === "true" ? !client.pending : !!client.pending) ||
        (!!composition &&
          b.dataset.compose !== "true" &&
          b.dataset.reconcile !== "true");
    });
  }
  async function run(action: () => Promise<string | void>) {
    if (busy || disposed) return;
    busy = true;
    lock();
    status.textContent = "Working…";
    try {
      const message = await action();
      if (!disposed)
        status.textContent = message ?? "Updated private workspace.";
    } catch (error) {
      if (!disposed)
        status.textContent = client.pending
          ? "Edit outcome unknown. Resolve pending edit before making another change."
          : error instanceof OperatorClientError
            ? (composition?.phase === "draft"
                ? "Conversation exists; draft remains incomplete. "
                : "") +
              error.code +
              " — refresh and review before another edit."
            : "Unable to update private workspace.";
    } finally {
      busy = false;
      if (!disposed) {
        folder.value = activeView;
        search.value = activeQuery;
        lock();
      }
    }
  }
  async function select(id: string) {
    const data = await client.thread(id);
    if (disposed) return;
    if (
      !data ||
      !Number.isSafeInteger(data.revision) ||
      !data.thread ||
      !Array.isArray(data.messages) ||
      !Array.isArray(data.drafts)
    )
      throw new OperatorClientError("invalid_response");
    revision = data.revision;
    selected = id;
    detail.replaceChildren(el("h3", data.thread.subject));
    for (const message of data.messages) {
      const article = el("article");
      article.append(el("p", message.from), el("pre", message.body));
      if (message.direction === "inbound")
        article.append(
          el("strong", "Attributed reply · unverified · no policy authority"),
        );
      detail.append(article);
    }
    const draft = data.drafts.find((v: any) => v.status === "draft"),
      subject = el("input"),
      body = el("textarea"),
      subjectLabel = el("label", "Draft subject"),
      bodyLabel = el("label", "Draft text");
    subject.value = draft?.subject ?? data.thread.subject;
    body.value = draft?.body ?? "";
    const originalSubject = subject.value,
      originalBody = body.value;
    unsaved = () =>
      subject.value !== originalSubject || body.value !== originalBody;
    subjectLabel.append(subject);
    bodyLabel.append(body);
    detail.append(subjectLabel, bodyLabel);
    detail.append(
      button("Save private draft", async () => {
        const command = draft
          ? {
              type: "reviseDraft" as const,
              inputId: crypto.randomUUID(),
              draftId: draft.id,
              expectedVersion: draft.version,
              content: {
                kind: "human" as const,
                subject: subject.value,
                body: body.value,
              },
            }
          : {
              type: "createDraft" as const,
              inputId: crypto.randomUUID(),
              draftId: crypto.randomUUID(),
              threadId: id,
              content: {
                kind: "human" as const,
                subject: subject.value,
                body: body.value,
              },
            };
        await client.submit(data.revision, command);
        await select(id);
        return "Private draft saved.";
      }),
    );
    detail.append(
      button("Mark read", async () => {
        await client.submit(data.revision, {
          type: "setThreadFlags",
          inputId: crypto.randomUUID(),
          threadId: id,
          read: true,
        });
        await refresh();
      }),
    );
    detail.append(
      button("Archive", async () => {
        await client.submit(data.revision, {
          type: "setThreadFlags",
          inputId: crypto.randomUUID(),
          threadId: id,
          folder: "archive",
        });
        selected = null;
        unsaved = () => false;
        detail.replaceChildren();
        await refresh();
      }),
    );
    detail.append(
      button("Close conversation", async () => {
        selected = null;
        unsaved = () => false;
        detail.replaceChildren();
        return "Conversation closed; unsaved local edits discarded.";
      }),
    );
    lock();
  }
  async function refresh(
    offset = pageOffset,
    expected?: number,
    filter = { view: activeView, query: activeQuery },
    resetSelection = false,
  ) {
    const session = await client.session(),
      page = await client.mail(filter.view, offset, filter.query);
    if (expected !== undefined && page.revision !== expected)
      throw new OperatorClientError("mailbox_changed");
    if (disposed) return;
    if (
      !page ||
      !Number.isSafeInteger(page.revision) ||
      !Array.isArray(page.threads)
    )
      throw new OperatorClientError("invalid_response");
    pageOffset = offset;
    activeView = filter.view;
    activeQuery = filter.query;
    folder.value = activeView;
    search.value = activeQuery;
    if (resetSelection) {
      selected = null;
      unsaved = () => false;
      detail.replaceChildren();
    }
    revision = page.revision;
    heading.textContent = session.brand + " · " + session.control + " control";
    list.replaceChildren(
      el("h3", folder.selectedOptions[0]?.textContent ?? activeView),
      el("p", activeQuery ? `Search: ${activeQuery}` : "No search filter"),
    );
    for (const thread of page.threads)
      list.append(button(thread.subject, () => select(thread.id)));
    list.append(
      el(
        "p",
        page.threads.length
          ? `${offset + 1}-${offset + page.threads.length} of ${page.total} conversations`
          : `No conversations on this page (${page.total} total)`,
      ),
    );
    if (offset > 0)
      list.append(
        button("Previous page", () =>
          refresh(Math.max(0, offset - 50), page.revision),
        ),
      );
    if (page.nextOffset !== null)
      list.append(
        button("Next page", () => refresh(page.nextOffset, page.revision)),
      );
    if (selected) await select(selected);
  }
  async function applyFilter(view: string, query: string) {
    if (client.pending || composition)
      throw new OperatorClientError("edit_pending");
    if (unsaved()) throw new OperatorClientError("unsaved_draft");
    await refresh(0, undefined, { view, query }, true);
  }
  folder.onchange = () => {
    void run(() => applyFilter(folder.value, activeQuery));
  };
  search.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run(() => applyFilter(activeView, search.value));
    }
  };
  navigation.append(
    folder,
    search,
    button("Search", () => applyFilter(activeView, search.value)),
    button("Clear search", () => applyFilter(activeView, "")),
  );
  toolbar.append(
    button("Refresh", () => refresh()),
    button("New conversation", async () => {
      selected = null;
      composition = null;
      unsaved = () => false;
      const recipient = el("input"),
        subject = el("input"),
        body = el("textarea");
      recipient.type = "email";
      for (const [label, input] of [
        ["Recipient", recipient],
        ["Subject", subject],
        ["Private draft", body],
      ] as const) {
        const l = el("label", label);
        l.append(input);
        if (label === "Recipient")
          detail.replaceChildren(el("h3", "New private conversation"));
        detail.append(l);
      }
      detail.append(
        button("Create conversation and draft", async () => {
          if (!composition) {
            composition = {
              recipient: recipient.value,
              subject: subject.value,
              body: body.value,
              threadId: crypto.randomUUID(),
              draftId: crypto.randomUUID(),
              threadInputId: crypto.randomUUID(),
              draftInputId: crypto.randomUUID(),
              phase: "thread",
              revision,
            };
            recipient.disabled = subject.disabled = body.disabled = true;
          }
          const c = composition;
          if (c.phase === "thread") {
            const r = await client.submit(c.revision, {
              type: "createThread",
              inputId: c.threadInputId,
              threadId: c.threadId,
              recipient: c.recipient,
              subject: c.subject,
            });
            c.phase = "draft";
            c.revision = r.revision;
          }
          await client.submit(c.revision, {
            type: "createDraft",
            inputId: c.draftInputId,
            threadId: c.threadId,
            draftId: c.draftId,
            content: { kind: "human", subject: c.subject, body: c.body },
          });
          composition = null;
          await select(c.threadId);
          return "Private conversation and draft created.";
        }),
        button("Cancel composition", async () => {
          const partial = composition?.phase === "draft";
          composition = null;
          detail.replaceChildren();
          await refresh();
          return partial
            ? "Conversation remains; unfinished draft was not claimed as saved."
            : "Composition closed.";
        }),
      );
    }),
    button("Take human control", async () => {
      const result = await client.submit(revision, {
        type: "setControl",
        inputId: crypto.randomUUID(),
        mode: "human",
      });
      const count = result.result.unrecallableIntentIds?.length ?? 0;
      await refresh();
      return count
        ? "Human control active; " +
            count +
            " committed handoff(s) cannot be recalled."
        : "Human control active.";
    }),
    button(
      "Resolve pending edit",
      async () => {
        const pending = client.pending;
        const result = await client.retryPending();
        if (
          composition &&
          pending?.command.inputId === composition.threadInputId
        ) {
          composition.phase = "draft";
          composition.revision = result.revision;
          return "Conversation creation reconciled. Select Create conversation and draft to finish the draft.";
        }
        if (
          composition &&
          pending?.command.inputId === composition.draftInputId
        ) {
          const id = composition.threadId;
          composition = null;
          await select(id);
          return "Private draft creation reconciled.";
        }
        await refresh();
        return "Original edit reconciled; workspace refreshed.";
      },
      true,
    ),
  );
  root.replaceChildren(heading, toolbar, navigation, status, list, detail);
  const ready = run(() => refresh());
  return {
    ready,
    dispose() {
      disposed = true;
      root.replaceChildren();
    },
  };
}
