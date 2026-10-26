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
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = d.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const heading = el("h2", "Private correspondence"),
    status = el("p"),
    list = el("section"),
    detail = el("section"),
    toolbar = el("div");
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
    b.onclick = () => {
      void run(action);
    };
    return b;
  }
  function lock() {
    root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled =
        busy ||
        (b.dataset.reconcile === "true" ? !client.pending : !!client.pending);
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
            ? error.code + " — refresh and review before another edit."
            : "Unable to update private workspace.";
    } finally {
      busy = false;
      if (!disposed) lock();
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
        await select(id);
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
        detail.replaceChildren();
        await refresh();
      }),
    );
    lock();
  }
  async function refresh() {
    const session = await client.session(),
      page = await client.mail("all");
    if (disposed) return;
    if (
      !page ||
      !Number.isSafeInteger(page.revision) ||
      !Array.isArray(page.threads)
    )
      throw new OperatorClientError("invalid_response");
    revision = page.revision;
    heading.textContent = session.brand + " · " + session.control + " control";
    list.replaceChildren();
    for (const thread of page.threads)
      list.append(button(thread.subject, () => select(thread.id)));
    if (page.nextOffset !== null)
      list.append(
        el(
          "p",
          "More conversations exist; use the host paginated inbox to view them.",
        ),
      );
    if (selected) await select(selected);
  }
  toolbar.append(
    button("Refresh", refresh),
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
        await client.retryPending();
        await refresh();
        return "Original edit reconciled; workspace refreshed.";
      },
      true,
    ),
  );
  root.replaceChildren(heading, toolbar, status, list, detail);
  const ready = run(refresh);
  return {
    ready,
    dispose() {
      disposed = true;
      root.replaceChildren();
    },
  };
}
