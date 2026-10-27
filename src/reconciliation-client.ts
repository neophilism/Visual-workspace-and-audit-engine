import type {
  TextReconciliationRequest,
  TextReconciliationResult,
} from "@accountability/processing/text-reconciliation";

export class ReconciliationClientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export type ReconciliationScope = Readonly<{
  tenantId: string;
  projectId: string;
}>;
function fail(code: string): never {
  throw new ReconciliationClientError(code);
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k))
  )
    fail("invalid_response");
  return value as Record<string, unknown>;
}
function identifier(v: unknown, max = 128): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= max &&
    v.trim().length > 0
  );
}
function capture(
  request: TextReconciliationRequest,
): TextReconciliationRequest {
  const r = exact(request, ["jobId", "consumedRevision", "output"]);
  if (
    !identifier(r.jobId) ||
    !Number.isSafeInteger(r.consumedRevision) ||
    (r.consumedRevision as number) < 3 ||
    (r.consumedRevision as number) >= Number.MAX_SAFE_INTEGER ||
    !["recover-stored", "finalize-existing"].includes(r.output as string)
  )
    fail("invalid_request");
  return {
    jobId: r.jobId,
    consumedRevision: r.consumedRevision as number,
    output: r.output as TextReconciliationRequest["output"],
  };
}
/** Explicit private reconciliation only. A pending request is never replaced or automatically replayed. */
export class ReconciliationClient {
  readonly #origin: string;
  readonly #scope: ReconciliationScope;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #actor: string | null = null;
  #pending: TextReconciliationRequest | null = null;
  #busy = false;
  #closed = false;
  #controller: AbortController | null = null;
  constructor(
    origin: string,
    scope: ReconciliationScope,
    transport: typeof fetch,
    timeoutMs = 15000,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      !identifier(scope.tenantId, 200) ||
      !identifier(scope.projectId, 200) ||
      typeof transport !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 30000
    )
      fail("invalid_configuration");
    this.#origin = origin;
    this.#scope = { tenantId: scope.tenantId, projectId: scope.projectId };
    this.#fetch = transport;
    this.#timeout = timeoutMs;
  }
  get origin(): string {
    return this.#origin;
  }
  get pending(): TextReconciliationRequest | null {
    return this.#pending ? { ...this.#pending } : null;
  }
  get closed(): boolean {
    return this.#closed;
  }
  dispose(): void {
    this.#closed = true;
    this.#actor = null;
    this.#controller?.abort();
  }

  async #exchange(
    path: string,
    payload?: string,
    csrf?: string,
  ): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController(),
      deadline = performance.now() + this.#timeout;
    this.#controller = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    const gate = () => {
      if (
        finished ||
        this.#closed ||
        controller.signal.aborted ||
        performance.now() >= deadline
      )
        fail("outcome_unknown");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () =>
        reject(new ReconciliationClientError("outcome_unknown"));
      controller.signal.addEventListener("abort", interrupt, { once: true });
      timer = setTimeout(() => controller.abort(), this.#timeout);
    });
    const operation = async () => {
      gate();
      const response = await this.#fetch(this.#origin + path, {
        method: payload === undefined ? "GET" : "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "x-csrf-token": csrf! }),
        },
        ...(payload === undefined ? {} : { body: payload }),
      });
      try {
        gate();
      } catch (e) {
        void response.body?.cancel().catch(() => {});
        throw e;
      }
      if (
        response.redirected ||
        (response.url && response.url !== this.#origin + path) ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "") ||
        ![null, "identity"].includes(
          response.headers.get("content-encoding"),
        ) ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        fail("invalid_response");
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0,
        count = 0;
      for (;;) {
        gate();
        const part = await reader.read();
        gate();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 262144 || ++count > 4096) fail("response_limit");
        chunks.push(new Uint8Array(part.value));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      gate();
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        fail("invalid_response");
      }
      gate();
      return { status: response.status, value };
    };
    try {
      return await Promise.race([operation(), interrupted]);
    } catch (e) {
      throw e instanceof ReconciliationClientError
        ? e
        : new ReconciliationClientError("outcome_unknown");
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener("abort", interrupt);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      if (this.#controller === controller) this.#controller = null;
    }
  }
  async #session(): Promise<string> {
    const response = await this.#exchange("/processing/session");
    if (response.status !== 200) fail("session_unavailable");
    const s = exact(response.value, [
      "csrfToken",
      "actorId",
      "tenantId",
      "projectId",
    ]);
    if (
      !identifier(s.actorId, 200) ||
      s.tenantId !== this.#scope.tenantId ||
      s.projectId !== this.#scope.projectId ||
      typeof s.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(s.csrfToken)
    )
      fail("invalid_response");
    if (this.#actor !== null && this.#actor !== s.actorId) {
      this.dispose();
      fail("identity_changed");
    }
    this.#actor = s.actorId;
    return s.csrfToken;
  }
  #result(
    value: unknown,
    request: TextReconciliationRequest,
    status: number,
  ): TextReconciliationResult {
    if (status === 503) {
      const r = exact(value, ["status", "phase"]);
      if (
        r.status !== "reconciliation-required" ||
        !["inspection", "output", "completion"].includes(r.phase as string)
      )
        fail("outcome_unknown");
      return {
        status: "reconciliation-required",
        phase: r.phase as "inspection" | "output" | "completion",
      };
    }
    if (status !== 200)
      fail(
        status >= 400 && status < 500 ? "request_rejected" : "outcome_unknown",
      );
    const r = exact(value, ["status", "jobId", "revision", "outcome"]);
    if (
      r.status !== "completed" ||
      r.jobId !== request.jobId ||
      r.revision !== request.consumedRevision + 1
    )
      fail("invalid_response");
    const o = exact(r.outcome, ["derivative", "sha256", "receipt"]);
    const ref = (value: unknown, kind: string) => {
      const v = exact(value, [
        "tenantId",
        "projectId",
        "kind",
        "id",
        "revision",
      ]);
      if (
        v.tenantId !== this.#scope.tenantId ||
        v.projectId !== this.#scope.projectId ||
        v.kind !== kind ||
        v.revision !== 1 ||
        typeof v.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.id)
      )
        fail("invalid_response");
    };
    ref(o.derivative, "processing-private-text");
    ref(o.receipt, "processing-output-receipt");
    if (
      typeof o.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(o.sha256) ||
      (o.derivative as { id: string }).id !== (o.receipt as { id: string }).id
    )
      fail("invalid_response");
    return structuredClone(value) as TextReconciliationResult;
  }
  async #run(
    request: TextReconciliationRequest,
  ): Promise<TextReconciliationResult> {
    const csrf = await this.#session();
    if (this.#closed) fail("client_closed");
    // Capture pending state before the transport can observe the command.
    this.#pending = { ...request };
    const response = await this.#exchange(
      "/processing/reconcile",
      JSON.stringify(request),
      csrf,
    );
    const result = this.#result(response.value, request, response.status);
    if (result.status === "completed") this.#pending = null;
    return result;
  }
  async reconcile(
    request: TextReconciliationRequest,
  ): Promise<TextReconciliationResult> {
    if (this.#closed || this.#busy || this.#pending) fail("client_locked");
    const captured = capture(request);
    this.#busy = true;
    try {
      return await this.#run(captured);
    } finally {
      this.#busy = false;
    }
  }
  async resolvePending(): Promise<TextReconciliationResult> {
    if (this.#closed || this.#busy || !this.#pending) fail("client_locked");
    const captured = { ...this.#pending! };
    this.#busy = true;
    try {
      return await this.#run(captured);
    } finally {
      this.#busy = false;
    }
  }
}
