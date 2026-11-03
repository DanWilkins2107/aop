import { ApiFailure, failureText } from "../lib/api.js";

/** Shows a failed load. An invalid config lists every problem, which is what a human needs to fix it. */
export function ErrorNotice({ error }: { error: unknown }) {
  const problems =
    error instanceof ApiFailure && error.code === "config_invalid" && Array.isArray(error.details)
      ? (error.details as string[])
      : [];
  return (
    <div className="banner banner-danger" role="alert">
      <strong>{failureText(error)}</strong>
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
