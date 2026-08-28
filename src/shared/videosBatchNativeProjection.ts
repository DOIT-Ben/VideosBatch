import "./types";

declare module "./types" {
  interface Asset {
    /** Stable VideosBatch business reference such as P001-A001. Native Asset.id remains runtime-owned. */
    workflowReferenceId?: string;
  }
}

export {};
