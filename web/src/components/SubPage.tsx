import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorNotice } from "./ErrorNotice.js";

/**
 * The frame of a page reached from the projects list: a breadcrumb back to it, then the title and
 * any failed load. `trail` goes after the "Projects" crumb.
 */
export function SubPage({
  title,
  trail,
  error,
  children,
}: {
  title?: string;
  trail?: ReactNode;
  error?: unknown;
  children: ReactNode;
}) {
  return (
    <div className="page page-narrow">
      <nav className="breadcrumb">
        <Link to="/">Projects</Link>
        {trail}
      </nav>
      {title ? <h1 className="settings-title">{title}</h1> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {children}
    </div>
  );
}
