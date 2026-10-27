import { importWebVtt } from "@accountability/processing/captions";
import type {
  MediaBinding,
  CaptionCue,
} from "@accountability/processing/captions";
import type { ProcessingInput } from "@accountability/processing";
import {
  canonical,
  digest,
  invariant,
  refKey,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace, renderWorkspace } from "./index.ts";
import type { WorkspaceSnapshot, VisualNode, WorkStage } from "./index.ts";
export type CaptionReviewInput = {
  derivative: { ref: Ref; sha256: string };
  captions: ProcessingInput;
  media: MediaBinding;
};
export type CaptionReviewWindow = { offset?: number; limit?: number };
const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Host-authenticated private snapshot only. Reparse exact captions and check stored derivative digest. */
export function projectCaptionReview(
  c: Context,
  input: CaptionReviewInput,
  stage: WorkStage,
  window: CaptionReviewWindow = {},
): WorkspaceSnapshot {
  const stored = structuredClone(input.derivative);
  validateRef(stored.ref);
  requireScope(c, stored.ref);
  invariant(
    stored.ref.kind !== "caption-cue-view",
    "reference_collision",
    "Stored derivative uses reserved cue-view kind",
  );
  const derivative = importWebVtt(c, input.captions, input.media);
  invariant(
    stored.sha256 === derivative.sha256,
    "derivative_mismatch",
    "Stored derivative does not match the source/media editions",
  );
  const offset = window.offset ?? 0,
    limit = window.limit ?? 100;
  invariant(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= derivative.cues.length &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= 200,
    "invalid_window",
    "Caption review window is invalid",
  );
  const nodes: VisualNode[] = [],
    sources = new Map<string, { ref: Ref; sha256: string }>();
  for (const binding of [
    { ref: derivative.source, sha256: derivative.sourceSha256 },
    { ref: derivative.media.source, sha256: derivative.media.sha256 },
  ]) {
    const key = refKey(binding.ref),
      old = sources.get(key);
    invariant(
      key !== refKey(stored.ref) && binding.ref.kind !== "caption-cue-view",
      "reference_collision",
      "Source collides with derivative or reserved cue-view kind",
    );
    invariant(
      !old ||
        (digest(old.ref) === digest(binding.ref) &&
          old.sha256 === binding.sha256),
      "reference_collision",
      "Source edition has an ambiguous reference or conflicting digest",
    );
    if (!old) {
      sources.set(key, binding);
      nodes.push({
        ref: binding.ref,
        label: "Source " + binding.ref.id,
        kind: "source",
        state: "exact-bound-edition",
        stage,
        dependencies: [],
        summary:
          "Bound evidence edition. This view does not establish factual accuracy or permission to publish.",
        details: json(binding),
      });
    }
  }
  nodes.push({
    ref: stored.ref,
    label: "Supplied caption review",
    kind: "artifact",
    state: "unverified-supplied-transcript",
    stage,
    dependencies: [...sources.values()].map((b) => b.ref),
    summary: `${derivative.cues.length} supplied cues; displaying ${Math.min(limit, derivative.cues.length - offset)}. Verify wording, timing and media association against the original evidence.`,
    details: json({
      derivative: stored,
      processor: derivative.processor,
      media: derivative.media,
      captionSource: {
        ref: derivative.source,
        sha256: derivative.sourceSha256,
      },
      warnings: derivative.warnings,
      window: {
        offset,
        limit,
        total: derivative.cues.length,
        nextOffset:
          offset + limit < derivative.cues.length ? offset + limit : null,
      },
      timeBasis: "Cue times are media offsets, not wall-clock audit events.",
    }),
  });
  for (const [index, cue] of derivative.cues
    .slice(offset, offset + limit)
    .entries()) {
    const ref = {
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind: "caption-cue-view",
      id: digest({
        derivative: stored.ref,
        sha256: stored.sha256,
        cueId: cue.id,
      }),
      revision: stored.ref.revision,
    };
    nodes.push({
      ref,
      label: `Cue ${offset + index + 1}: ${cue.startMs}-${cue.endMs} ms`,
      kind: "claim",
      state: "supplied-caption-unverified",
      stage,
      dependencies: [stored.ref],
      summary:
        cue.text.length > 500
          ? cue.text.slice(0, 500) + "… (full text in inspector)"
          : cue.text,
      details: json({
        containingDerivative: stored.ref,
        cue,
        captionSource: derivative.source,
        sourceSha256: derivative.sourceSha256,
        media: derivative.media,
        byteRange:
          "Half-open UTF-8 offsets in original caption bytes; excludes final payload line terminator.",
      }),
    });
  }
  const result: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private source-linked caption review",
    capturedAt: c.now,
    nodes,
    events: [],
    agents: [],
  };
  layoutWorkspace(c, result);
  return result;
}
/** Static private review; no media URLs, playback requests, commands or publication routes. */
export function renderCaptionReview(
  c: Context,
  input: CaptionReviewInput,
  stage: WorkStage,
  window: CaptionReviewWindow = {},
): string {
  const snapshot = projectCaptionReview(c, input, stage, window),
    layout = layoutWorkspace(c, snapshot);
  const rows = layout.nodes
    .flatMap(({ node }, index) => {
      if (node.ref.kind !== "caption-cue-view") return [];
      const { cue } = node.details as unknown as { cue: CaptionCue };
      return [{ cue, index, label: node.label }];
    })
    .sort((a, b) => a.cue.sourceByteStart - b.cue.sourceByteStart)
    .map(
      ({ cue, index, label }) =>
        `<tr><td><button data-node="${index}">${escape(label)}</button></td><td>${cue.startMs}–${cue.endMs}</td><td><pre>${escape(cue.text)}</pre></td><td>${cue.sourceByteStart}–${cue.sourceByteEnd}</td></tr>`,
    )
    .join("");
  const section = `<section class="table"><h2>Supplied transcript — review required</h2><p>Times are milliseconds into the bound media edition. Text is supplied, not independently verified. This window does not imply a complete record.</p><table><thead><tr><th scope="col">Cue</th><th scope="col">Media time (ms)</th><th scope="col">Literal text</th><th scope="col">Original caption bytes</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  return renderWorkspace(c, snapshot).replace("</main>", section + "</main>");
}
