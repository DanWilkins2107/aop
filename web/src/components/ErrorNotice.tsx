import type { ReactNode } from "react";
import { ApiFailure, failureText } from "../lib/api.js";

/** A danger banner listing every problem, which is what a human needs to fix them. */
export function ProblemBanner({ title, problems }: { title: ReactNode; problems: string[] }) {
  return (
    <div className="banner banner-danger" role="alert">
      <strong>{title}</strong>
      {problems.length > 0 ? (
        <ul className="problem-list">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Shows a failed load. An invalid config lists every problem. */
export function ErrorNotice({ error }: { error: unknown }) {
  const problems =
    error instanceof ApiFailure && error.code === "config_invalid" && Array.isArray(error.details)
      ? (error.details as string[])
      : [];
  return <ProblemBanner title={failureText(error)} problems={problems} />;
}
