import type { ReactNode } from "react";
import { productStepIndexLabel, productStepName, type VideosBatchProductStepId } from "../stageModel";

/**
 * One shared stage shell for every step of the workflow.
 *
 * Every stage opens with the same slate: the step number set large in the data
 * face, the step name above a plain-language title, and the stage's facts on
 * the right — all resting on one hairline that spans the shared measure. The
 * nine steps read as nine passes over the same document rather than as nine
 * differently laid-out pages.
 *
 * The step number and label come from stageModel, so neither is re-typed
 * inside nine stage components.
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

  // The kicker names the step ("最终成片"); when the stage title says exactly the same
  // thing the pair reads as a stutter, so the kicker yields (e.g. the final delivery).
  const stepName = productStepName(stepId);
  const kicker = typeof title === "string" && title === stepName ? null : (
    <p className="vbs-stage-kicker">{stepName}</p>
  );

  return (
    <section className={`vbs-stage-page${className ? ` ${className}` : ""}`}>
      <header className="vbs-stage-slate">
        <span className="vbs-stage-numeral" aria-hidden="true">{productStepIndexLabel(stepId)}</span>
        <div className="vbs-stage-heading">
          {kicker}
          <h2>{title}</h2>
          {lead ? <p className="vbs-stage-lead">{lead}</p> : null}
        </div>
        {asideContent ? <div className="vbs-document-aside">{asideContent}</div> : null}
      </header>
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
