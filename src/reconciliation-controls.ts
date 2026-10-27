import type {
  TextReconciliationRequest,
  TextReconciliationResult,
} from "@accountability/processing/text-reconciliation";
import { ReconciliationClient } from "./reconciliation-client.ts";

/** Mount only into an authenticated same-origin private host. Pending state is memory-only. */
export function mountReconciliationControls(
  root: HTMLElement,
  client: ReconciliationClient,
): { dispose(): void } {
  const document = root.ownerDocument;
  if (document.location.origin !== client.origin) throw Error("origin_denied");
  let disposed = false,
    busy = false;
  const heading = document.createElement("h2");
  heading.textContent = "Private processing reconciliation";
  const note = document.createElement("p");
  note.textContent =
    "Review the exact consumed execution and select one explicit action. Unknown results are not rollback or proof that no output exists. Recovery never reruns processing.";
  const form = document.createElement("form");
  const field = (name: string, input: HTMLInputElement | HTMLSelectElement) => {
    const label = document.createElement("label");
    label.textContent = name;
    label.append(input);
    form.append(label);
  };
  const job = document.createElement("input");
  job.type = "text";
  job.maxLength = 128;
  job.required = true;
  field("Job ID", job);
  const revision = document.createElement("input");
  revision.type = "number";
  revision.min = "3";
  revision.step = "1";
  revision.required = true;
  field("Consumed revision", revision);
  const mode = document.createElement("select");
  mode.required = true;
  for (const [value, text] of [
    ["", "Choose recovery action"],
    ["recover-stored", "Recover committed output"],
    ["finalize-existing", "Finalize existing private bytes"],
  ]) {
    const option = document.createElement("option");
    option.value = value!;
    option.textContent = text!;
    mode.append(option);
  }
  field("Output action", mode);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Reconcile reviewed execution";
  const resolve = document.createElement("button");
  resolve.type = "button";
  resolve.textContent = "Resolve exact pending request";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const details = document.createElement("pre");
  details.setAttribute(
    "aria-label",
    "Exact reconciliation result or pending request",
  );
  form.append(submit, resolve);
  root.replaceChildren(heading, note, form, status, details);
  function update() {
    if (disposed) return;
    const pending = client.pending;
    if (pending) {
      job.value = pending.jobId;
      revision.value = String(pending.consumedRevision);
      mode.value = pending.output;
    }
    const locked = busy || pending !== null || client.closed;
    job.disabled = revision.disabled = mode.disabled = submit.disabled = locked;
    resolve.disabled = busy || pending === null || client.closed;
    if (pending) details.textContent = JSON.stringify(pending, null, 2);
  }
  async function run(operation: () => Promise<TextReconciliationResult>) {
    if (disposed || busy || client.closed) return;
    busy = true;
    status.textContent = "Checking current session and exact execution…";
    update();
    try {
      const result = await operation();
      if (disposed) return;
      if (result.status === "completed") {
        status.textContent =
          "Completion acknowledged for this exact execution. This is a historical result; refresh the authorized task view separately.";
        details.textContent = JSON.stringify(result, null, 2);
      } else
        status.textContent =
          "Outcome unknown; explicit reconciliation required. Diagnostic phase: " +
          result.phase +
          ". The original request remains locked.";
    } catch {
      if (disposed) return;
      status.textContent = client.closed
        ? "Session identity changed or client closed. Host review is required; the pending request is retained."
        : client.pending
          ? "Outcome unknown or request rejected. The original request remains locked; no rollback or absence is certified."
          : "Session or input unavailable. No reconciliation command was issued by this client.";
    } finally {
      busy = false;
      update();
    }
  }
  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (busy || client.pending || client.closed || disposed) return;
    const request = {
      jobId: job.value,
      consumedRevision: Number(revision.value),
      output: mode.value,
    } as TextReconciliationRequest;
    void run(() => client.reconcile(request));
  };
  const onResolve = () => {
    if (client.pending) void run(() => client.resolvePending());
  };
  form.addEventListener("submit", onSubmit);
  resolve.addEventListener("click", onResolve);
  update();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      form.removeEventListener("submit", onSubmit);
      resolve.removeEventListener("click", onResolve);
      client.dispose();
      root.replaceChildren();
    },
  };
}
