import type { ReactNode } from "react";

/** All workspaces share the daily review's editorial masthead. */
export function PageHeading({
  eyebrow,
  title,
  english,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  english: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading rise-in">
      <div className="page-heading-copy">
        <p className="page-eyebrow">{eyebrow} / TREND ADAPTIVE</p>
        <h1>{title}<span>{english}</span></h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {action ? <div className="page-heading-action">{action}</div> : null}
    </header>
  );
}
