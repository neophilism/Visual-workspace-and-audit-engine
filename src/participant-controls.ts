import { ParticipantClient } from "@accountability/consent-rights/participant-client";
import type { ParticipantResult } from "@accountability/consent-rights/participant-client";
import type { ParticipantReview } from "@accountability/consent-rights/participant";

/** Private same-origin participant controls. Hosting, identity and accessible presentation require qualification. */
export function mountParticipantControls(
  root: HTMLElement,
  client: ParticipantClient,
  offerId: string,
): { dispose(): void } {
  const document = root.ownerDocument;
  if (document.location.origin !== client.origin) throw Error("origin_denied");
  if (typeof offerId !== "string" || !offerId.trim() || offerId.length > 200)
    throw Error("invalid_offer");
  const pending = client.pending;
  const pendingId =
    pending?.operation === "respond"
      ? pending.command.input.offerId
      : pending?.command.offerId;
  if (pendingId !== undefined && pendingId !== offerId)
    throw Error("pending_offer_mismatch");
  let disposed = false,
    busy = false,
    viewed: ParticipantReview | null = null;
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const heading = element("h2", "Private participant consent review");
  const note = element(
    "p",
    "Participation is optional. Review the exact disclosure and terms before choosing. Consent is separate from rights and release authorization. No acceptance is preselected.",
  );
  const selected = element("p", "Offer ID: " + offerId);
  const reviewButton = element("button", "Review current offer");
  const accept = element("button", "Accept reviewed terms");
  const decline = element("button", "Decline reviewed offer");
  const withdraw = element("button", "Withdraw reviewed consent");
  const resolve = element("button", "Resolve exact pending request");
  for (const button of [reviewButton, accept, decline, withdraw, resolve])
    button.type = "button";
  const disclosure = element("section");
  disclosure.setAttribute("aria-label", "Exact reviewed disclosure and terms");
  const ackLabel = element(
    "label",
    "I acknowledge the exact disclosure and terms shown above.",
  );
  const ack = element("input");
  ack.type = "checkbox";
  ack.checked = false;
  ackLabel.prepend(ack);
  const status = element(
    "p",
    "No offer has been loaded. Review is an explicit read; it does not record consent.",
  );
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const receipt = element("pre");
  receipt.setAttribute(
    "aria-label",
    "Historical receipt or immutable pending request",
  );
  root.replaceChildren(
    heading,
    note,
    selected,
    reviewButton,
    disclosure,
    ackLabel,
    accept,
    decline,
    withdraw,
    resolve,
    status,
    receipt,
  );
  function update() {
    if (disposed) return;
    const locked = busy || client.closed || !!client.pending;
    reviewButton.disabled = locked;
    ack.disabled = locked || !viewed?.responseOpen;
    accept.disabled = locked || !viewed?.responseOpen || !ack.checked;
    decline.disabled = locked || !viewed?.responseOpen;
    withdraw.disabled =
      locked ||
      viewed?.offer.status !== "accepted" ||
      !viewed.consent ||
      viewed.consent.withdrawnAt !== null;
    resolve.disabled = busy || client.closed || !client.pending;
    if (client.pending)
      receipt.textContent = JSON.stringify(client.pending, null, 2);
    if (client.closed)
      status.textContent =
        "Client closed or session identity changed. Host review is required; retain any pending request.";
  }
  function showReview(review: ParticipantReview) {
    const body = element("p", review.offer.disclosure);
    body.style.whiteSpace = "pre-wrap";
    const terms = element("dl");
    const row = (label: string, value: string) =>
      terms.append(element("dt", label), element("dd", value));
    row("Stored offer", JSON.stringify(review.offer.ref));
    row("Exact review digest", review.reviewDigest);
    row("Subject", review.offer.subjectId);
    row(
      "Resource edition and digest",
      JSON.stringify(review.offer.terms.resource),
    );
    row("Actions", review.offer.terms.actions.join(", "));
    row("Purposes", review.offer.terms.purposes.join(", "));
    row("Audiences", review.offer.terms.audiences.join(", "));
    row(
      "Permission time window",
      review.offer.terms.validFrom + " until " + review.offer.terms.expiresAt,
    );
    row("Response deadline", review.offer.responseExpiresAt);
    row("Evidence edition", JSON.stringify(review.offer.terms.evidence));
    row("Offer status", review.offer.status);
    if (review.offer.consent)
      row(
        "Original capture binding (historical)",
        JSON.stringify(review.offer.consent),
      );
    if (review.consent) {
      row("Current consent edition", JSON.stringify(review.consent.ref));
      row(
        "Current withdrawal record",
        review.consent.withdrawnAt ??
          "No withdrawal recorded in this snapshot; this is not a use authorization.",
      );
    }
    disclosure.replaceChildren(
      element("h3", "Exact disclosure"),
      body,
      element("h3", "Exact terms"),
      terms,
      ...review.warnings.map((w) => element("p", w)),
    );
  }
  async function read() {
    if (disposed || busy || client.closed || client.pending) return;
    busy = true;
    viewed = null;
    ack.checked = false;
    receipt.textContent = "";
    disclosure.replaceChildren();
    status.textContent = "Checking session and current offer…";
    update();
    try {
      const review = await client.review(offerId);
      if (disposed) return;
      viewed = review;
      showReview(review);
      status.textContent = review.responseOpen
        ? "Review loaded. Choose explicitly; acknowledgement is required for acceptance."
        : review.consent?.withdrawnAt
          ? "Consent withdrawal is recorded in this snapshot. The original capture remains historical."
          : "Response is closed. An existing capture is historical; this screen does not authorize use.";
    } catch {
      if (!disposed)
        status.textContent =
          "Current review unavailable. No decision was recorded by this read; no prior view is actionable.";
    } finally {
      busy = false;
      update();
    }
  }
  async function command(operation: () => Promise<ParticipantResult>) {
    if (disposed || busy || client.closed) return;
    busy = true;
    update();
    status.textContent = "Checking current session and exact request…";
    try {
      const result = await operation();
      if (disposed) return;
      viewed = null;
      ack.checked = false;
      receipt.textContent = JSON.stringify(result, null, 2);
      status.textContent =
        result.operation === "withdraw"
          ? "Withdrawal acknowledged for the reviewed edition. Review current state separately; copies already obtained cannot be recalled."
          : "Historical " +
            result.offer.status +
            " receipt acknowledged. Review current state separately; this receipt is not permission to use or publish.";
    } catch {
      if (disposed) return;
      status.textContent = client.pending
        ? "Outcome unknown or request rejected. The exact original request remains locked. Only explicit identical replay is available; do not create a replacement command."
        : "Session or decision unavailable. This client has no pending mutation; review again before choosing.";
      if (!client.pending) {
        viewed = null;
        ack.checked = false;
      }
    } finally {
      busy = false;
      update();
    }
  }
  const onRead = () => {
    void read();
  };
  const onAck = () => {
    update();
  };
  const onAccept = () => {
    if (
      disposed ||
      busy ||
      client.pending ||
      client.closed ||
      !viewed?.responseOpen ||
      !ack.checked
    )
      return;
    const commandId = crypto.randomUUID();
    void command(() =>
      client.respond(commandId, { response: "accept", acknowledged: true }),
    );
  };
  const onDecline = () => {
    if (
      disposed ||
      busy ||
      client.pending ||
      client.closed ||
      !viewed?.responseOpen
    )
      return;
    const commandId = crypto.randomUUID();
    void command(() =>
      client.respond(commandId, {
        response: "decline",
        acknowledged: ack.checked,
      }),
    );
  };
  const onWithdraw = () => {
    if (
      disposed ||
      busy ||
      client.pending ||
      client.closed ||
      viewed?.offer.status !== "accepted" ||
      !viewed.consent ||
      viewed.consent.withdrawnAt !== null
    )
      return;
    const commandId = crypto.randomUUID();
    void command(() => client.withdraw(commandId));
  };
  const onResolve = () => {
    if (client.pending) void command(() => client.resolvePending());
  };
  const events: [HTMLElement, string, EventListener][] = [
    [reviewButton, "click", onRead],
    [ack, "change", onAck],
    [accept, "click", onAccept],
    [decline, "click", onDecline],
    [withdraw, "click", onWithdraw],
    [resolve, "click", onResolve],
  ];
  for (const [node, event, callback] of events)
    node.addEventListener(event, callback);
  update();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [node, event, callback] of events)
        node.removeEventListener(event, callback);
      client.dispose();
      root.replaceChildren();
    },
  };
}
