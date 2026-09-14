import type { ReactNode } from "react";
import { productStepKicker, type VideosBatchProductStepId } from "../stageModel";

/**
 * One shared stage shell for every step of the workflow.
 *
 * The step number and label come from stageModel, so the "03 · 故事文稿" kicker
 * exists once instead of being re-typed inside nine stage components.
 */
export function StagePage({
  stepId,
  title,
  lead,
  facts,
  actions,
  aside,
  className,
  children
}: {
  stepId: VideosBatchProductStepId;
  title: ReactNode;
  lead?: ReactNode;
  facts?: ReactNode;
  actions?: ReactNode;
  /** Replaces the default facts/actions column when a step needs custom content. */
  aside?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const asideContent = aside ?? (facts || actions ? (
    <>
      {facts ? <div className="vbs-document-facts">{facts}</div> : null}
      {actions ? <div className="vbs-document-actions">{actions}</div> : null}
    </>
  ) : null);

  return (
    <section className={`vbs-stage-page${className ? ` ${className}` : ""}`}>
      <p className="vbs-stage-kicker">{productStepKicker(stepId)}</p>
      <div className="vbs-document-header">
        <div>
          <h2>{title}</h2>
          {lead ? <p>{lead}</p> : null}
        </div>
        {asideContent ? <div className="vbs-document-aside">{asideContent}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One key figure shown to the right of the stage title. */
export function StageFact({ value, label }: { value: ReactNode; label: string }) {
  return <span><strong>{value}</strong><small>{label}</small></span>;
}

/** Placeholder for a step whose artifact does not exist yet. */
export function StageEmpty({ children }: { children: ReactNode }) {
  return <div className="vbs-empty-card">{children}</div>;
}
