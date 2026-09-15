import "./types";

/**
 * One immutable VideosBatch reference binding. `ordinal` is the provider-facing
 * 1-based position; the other fields keep the business identity and a
 * redacted audit fingerprint without putting stable public ids in provider text.
 *
 * `imageUrlHash` proves *which URL* was submitted; `bytesSha256` proves *which
 * bytes*. The two are not interchangeable: a URL can keep its address while its
 * content changes (re-signed CDN object, re-uploaded asset), and only the
 * content address catches that before a paid generation. Fields are optional so
 * snapshots written before this contract still load and still resume polling.
 */
export interface VideosBatchReferenceBinding {
  referenceId: string;
  ordinal: number;
  assetKey: string;
  assetId: string;
  semanticLabel: string;
  imageUrlHash?: string;
  /** SHA-256 of the exact submitted bytes. */
  bytesSha256?: string;
  /** Length of the exact submitted bytes. */
  byteSize?: number;
  /** Submitted content type, from the response header or the local extension. */
  mimeType?: string;
}

type VideosBatchPromptRendering = "full" | "compact";

declare module "./types" {
  interface Asset {
    /** Stable VideosBatch business reference such as P001-A001. Native Asset.id remains runtime-owned. */
    workflowReferenceId?: string;
    /** Model-owned assetKey is persisted separately so reordering a plan cannot renumber assets. */
    videosBatchAssetKey?: string;
  }

  interface Shot {
    /** Identifies the FINAL_STORYBOARD revision currently projected into this native shot. */
    videosBatchBatchId?: string;
    videosBatchSourceRevision?: number;
    videosBatchSourceHash?: string;
    /** Lineage of the confirmed ASSET_PLAN used to compile this shot. */
    videosBatchAssetPlanRevision?: number;
    videosBatchAssetPlanHash?: string;
    /** Hashes of the immutable execution package and exact provider prompt. */
    videosBatchPackageContentHash?: string;
    videosBatchPromptHash?: string;
    videosBatchPromptCompilerVersion?: string;
    videosBatchPromptRendering?: VideosBatchPromptRendering;
    /** Ordered semantic-to-native reference snapshot used by VideosBatch media execution. */
    videosBatchReferenceBindings?: VideosBatchReferenceBinding[];
  }

  interface ShotRender {
    /** Snapshot of the VideosBatch storyboard batch that produced this render. */
    videosBatchBatchId?: string;
    /** Exact ordered references submitted for this render, with URL and byte hashes only. */
    videosBatchReferenceBindings?: VideosBatchReferenceBinding[];
  }

  interface StitchJob {
    /** VideosBatch batch represented by this stitch job. */
    videosBatchBatchId?: string;
  }
}

export {};
