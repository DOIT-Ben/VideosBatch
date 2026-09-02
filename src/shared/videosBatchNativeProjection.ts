import "./types";

/**
 * One immutable VideosBatch reference binding. `ordinal` is the provider-facing
 * 1-based position; the other fields keep the business identity and a
 * redacted audit fingerprint without putting stable public ids in provider text.
 */
export interface VideosBatchReferenceBinding {
  referenceId: string;
  ordinal: number;
  assetKey: string;
  assetId: string;
  semanticLabel: string;
  imageUrlHash?: string;
}

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
    /** Ordered semantic-to-native reference snapshot used by VideosBatch media execution. */
    videosBatchReferenceBindings?: VideosBatchReferenceBinding[];
  }

  interface ShotRender {
    /** Snapshot of the VideosBatch storyboard batch that produced this render. */
    videosBatchBatchId?: string;
    /** Exact ordered references submitted for this render, with URL hashes only. */
    videosBatchReferenceBindings?: VideosBatchReferenceBinding[];
  }

  interface StitchJob {
    /** VideosBatch batch represented by this stitch job. */
    videosBatchBatchId?: string;
  }
}

export {};
