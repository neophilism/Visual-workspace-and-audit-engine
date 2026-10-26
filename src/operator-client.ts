import type { CorrespondenceCommand } from "@accountability/correspondence";
export type PrivateCommand = Extract<
  CorrespondenceCommand,
  {
    type:
      | "createThread"
      | "createDraft"
      | "reviseDraft"
      | "discardDraft"
      | "setThreadFlags"
      | "setControl"
      | "suppressRecipient"
      | "cancelIntent";
  }
>;
export class OperatorClientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export type OperatorSession = {
  mailboxId: string;
  brand: string;
  control: string;
  revision: number;
  csrfToken: string;
};
export type PendingEdit = { expectedRevision: number; command: PrivateCommand };
export class OperatorClient {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #session: OperatorSession | null = null;
  #pending: PendingEdit | null = null;
  #busy = false;
  constructor(origin: string, transport: typeof fetch, timeoutMs = 5000) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== origin ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 30000
    )
      throw new OperatorClientError("invalid_configuration");
    this.#origin = origin;
    this.#fetch = transport;
    this.#timeout = timeoutMs;
  }
  get origin(): string {
    return this.#origin;
  }
  get pending(): PendingEdit | null {
    return this.#pending ? structuredClone(this.#pending) : null;
  }
  async #read(path: string, method = "GET", payload?: unknown): Promise<any> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const operation = async () => {
      const result = await this.#fetch(this.#origin + path, {
        method,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "x-csrf-token": this.#session!.csrfToken,
              }
            : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (controller.signal.aborted)
        throw new OperatorClientError("outcome_unknown");
      if (
        result.redirected ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          result.headers.get("content-type") ?? "",
        ) ||
        !result.body
      )
        throw new OperatorClientError("invalid_response");
      reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0,
        count = 0;
      for (;;) {
        if (controller.signal.aborted)
          throw new OperatorClientError("outcome_unknown");
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 2 * 1024 * 1024 || ++count > 4096)
          throw new OperatorClientError("response_limit");
        chunks.push(new Uint8Array(r.value));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      let value: any;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new OperatorClientError("invalid_response");
      }
      if (!result.ok)
        throw new OperatorClientError(
          result.status === 409
            ? "revision_conflict"
            : result.status >= 400 && result.status < 500
              ? "request_rejected"
              : "outcome_unknown",
        );
      return value;
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new OperatorClientError("outcome_unknown"));
          }, this.#timeout);
        }),
      ]);
    } catch (e) {
      throw e instanceof OperatorClientError
        ? e
        : new OperatorClientError("outcome_unknown");
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  async session(): Promise<OperatorSession> {
    const s = await this.#read("/operator/session");
    if (
      !s ||
      typeof s.mailboxId !== "string" ||
      typeof s.brand !== "string" ||
      !["human", "autonomous"].includes(s.control) ||
      !Number.isSafeInteger(s.revision) ||
      s.revision < 0 ||
      typeof s.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(s.csrfToken)
    )
      throw new OperatorClientError("invalid_response");
    this.#session = structuredClone(s);
    return structuredClone(s);
  }
  async mail(view = "inbox") {
    return this.#read("/operator/mail?view=" + encodeURIComponent(view));
  }
  async thread(id: string) {
    return this.#read("/operator/thread?id=" + encodeURIComponent(id));
  }
  async submit(
    expectedRevision: number,
    command: PrivateCommand,
  ): Promise<any> {
    if (this.#busy || this.#pending)
      throw new OperatorClientError("edit_pending");
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      ![
        "createThread",
        "createDraft",
        "reviseDraft",
        "discardDraft",
        "setThreadFlags",
        "setControl",
        "suppressRecipient",
        "cancelIntent",
      ].includes(command.type) ||
      (command.type === "setControl" && command.mode !== "human")
    )
      throw new OperatorClientError("command_denied");
    this.#pending = structuredClone({ expectedRevision, command });
    return this.#attempt(false);
  }
  /** Explicit reconciliation reuses the exact original command and revision. Never automatic. */
  async retryPending(): Promise<any> {
    if (this.#busy || !this.#pending)
      throw new OperatorClientError("no_pending_edit");
    return this.#attempt(true);
  }
  async #attempt(reconciling: boolean) {
    this.#busy = true;
    try {
      await this.session();
      const result = await this.#read(
        "/operator/command",
        "POST",
        this.#pending,
      );
      if (
        !result ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 0 ||
        typeof result.duplicate !== "boolean" ||
        !result.result
      )
        throw new OperatorClientError("invalid_response");
      this.#pending = null;
      return result;
    } catch (e) {
      if (
        !reconciling &&
        e instanceof OperatorClientError &&
        ["revision_conflict", "request_rejected"].includes(e.code)
      )
        this.#pending = null;
      throw e;
    } finally {
      this.#busy = false;
    }
  }
}
