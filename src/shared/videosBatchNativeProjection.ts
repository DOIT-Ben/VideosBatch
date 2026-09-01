import "./types";

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
  }

  interface ShotRender {
    /** Snapshot of the VideosBatch storyboard batch that produced this render. */
    videosBatchBatchId?: string;
  }

  interface StitchJob {
    /** VideosBatch batch represented by this stitch job. */
    videosBatchBatchId?: string;
  }
}

export {};
