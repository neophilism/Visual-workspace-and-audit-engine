import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "@accountability/evidence/database";
import { PrivateObjectStore } from "@accountability/evidence/objects";
import { TextProcessingJobs } from "@accountability/processing/text-jobs";
import { PrivateTextOutputs } from "@accountability/processing/text-outputs";
import { createReconciliationHandler } from "@accountability/processing/reconciliation-http";
import { extractUtf8 } from "@accountability/processing";
import { hashBytes } from "../src/contracts.ts";
import { ReconciliationClient } from "../src/reconciliation-client.ts";
export const origin = "https://workspace.example";
export const context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "owner", kind: "human" as const, roles: ["owner"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00Z",
};
export const action = {
  jobId: "actual",
  consumedRevision: 3,
  output: "finalize-existing" as const,
};
export async function fixture(t: TestContext) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE visual_processing_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO visual_processing_login; SET SESSION AUTHORIZATION visual_processing_login",
  );
  const db: Database = {
    transaction: (fn) =>
      pg.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => ({
            rows: (await q.query(sql, values)).rows as T[],
          }),
        }),
      ),
    close: async () => {},
  };
  const root = await mkdtemp(join(tmpdir(), "visual-reconciliation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new PrivateObjectStore(
    root,
    randomBytes(32),
    "fictional-key",
  );
  const bytes = Buffer.from("hello"),
    source = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      kind: "evidence",
      id: "text",
      revision: 2,
    };
  let allowed = true,
    actorId = context.actor.id,
    csrf = "s".repeat(40),
    reads = 0;
  const readSource = async () => {
    reads++;
    return {
      source,
      sha256: hashBytes(bytes),
      bytes,
      scanStatus: "clean" as const,
      processingAllowed: true,
    };
  };
  const policy = {
    tenantId: context.tenantId,
    projectId: context.projectId,
    managerIds: ["owner", "second"],
    workerIds: ["worker"],
    verificationTimeoutMs: 5000,
  };
  const outputs = new PrivateTextOutputs(
    db,
    objects,
    { ...policy, readSource, authorize: async () => allowed },
    () => context.now,
  );
  const jobs = new TextProcessingJobs(
    db,
    policy,
    {
      authorizeStart: async () => true,
      verifyOutcome: outputs.verifyOutcome.bind(outputs),
    },
    () => context.now,
  );
  const worker = {
    ...context,
    actor: { id: "worker", kind: "service" as const, roles: ["process"] },
  };
  await jobs.submit(
    context,
    {
      id: "actual",
      source,
      sourceSha256: hashBytes(bytes),
      sourceBytes: bytes.length,
      language: null,
    },
    "submit",
  );
  await jobs.lease(worker, "actual", 1);
  const consumed = await jobs.consume(worker, "actual", 2);
  // Force a real SQL rollback AFTER encrypted bytes exist, retaining the durable pending intent.
  let injected = false;
  const fault: Database = {
    transaction: (fn) =>
      db.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const result = await q.query<T>(sql, values);
            if (
              !injected &&
              sql.includes("INSERT INTO public.evidence_outbox") &&
              values?.includes("processing.output.stored")
            ) {
              injected = true;
              throw Error("fixture rollback");
            }
            return result;
          },
        }),
      ),
    close: async () => {},
  };
  await assert.rejects(
    new PrivateTextOutputs(
      fault,
      objects,
      { ...policy, readSource, authorize: async () => allowed },
      () => context.now,
    ).storePrivateText(
      consumed,
      extractUtf8(context, await readSource()),
      worker,
      new AbortController().signal,
    ),
  );
  assert.equal(injected, true);
  objects.put = async () => {
    throw Error("reconciliation must not write bytes");
  };
  const handler = createReconciliationHandler(
    jobs,
    outputs,
    {
      authenticate: async () => ({
        context: { ...context, actor: { ...context.actor, id: actorId } },
        csrfToken: csrf,
      }),
    },
    { ...policy, origin, purpose: context.purpose },
    () => context.now,
  );
  const requests: { path: string; body: string | null; csrf: string | null }[] =
    [];
  const transport: typeof fetch = async (url, init) => {
    // The browser supplies Origin/Fetch Metadata. Inject them only in this native Fetch test bridge.
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("sec-fetch-site", "same-origin");
    const request = new Request(String(url), { ...init, headers });
    requests.push({
      path: new URL(request.url).pathname,
      body: init?.body ? String(init.body) : null,
      csrf: headers.get("x-csrf-token"),
    });
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return handler(request);
  };
  return {
    jobs,
    outputs,
    transport,
    requests,
    client: new ReconciliationClient(origin, context, transport),
    reads: () => reads,
    deny: () => {
      allowed = false;
    },
    switchActor: () => {
      actorId = "second";
      csrf = "t".repeat(40);
    },
    rotateCsrf: () => {
      csrf = "u".repeat(40);
    },
  };
}
