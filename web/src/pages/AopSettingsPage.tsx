import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";

function Setting({ name, value, resolved }: { name: string; value: ReactNode; resolved?: string }) {
  return (
    <div className="setting">
      <dt className="mono">{name}</dt>
      <dd className="mono">{value}</dd>
      {resolved ? (
        <dd className="setting-resolved">
          Resolves to <span className="mono">{resolved}</span>
        </dd>
      ) : null}
    </div>
  );
}

const NOT_SET = <span className="muted">Not set</span>;

/** Read-only by design: agents can reach the API, so nothing here can change commands or the sandbox. */
export function AopSettingsPage() {
  const { data, error } = useLiveData(() => api.config(), "config");
  const settings = data?.settings;
  return (
    <div className="page page-narrow">
      <nav className="breadcrumb">
        <Link to="/">Projects</Link>
      </nav>
      <h1 className="settings-title">AOP settings</h1>
      {error ? <ErrorNotice error={error} /> : null}
      {data ? (
        <p className="settings-note">
          Read-only. To change these, edit <code>{data.config_path}</code>.
        </p>
      ) : null}
      {data && data.problems.length > 0 ? (
        <div className="banner banner-danger" role="alert">
          <strong>The AOP config is invalid</strong>
          <ul className="problem-list">
            {data.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {settings ? (
        <dl className="settings-list">
          <Setting name="sandboxed_command" value={settings.sandboxed_command ?? NOT_SET} />
          <Setting name="non_sandboxed_command" value={settings.non_sandboxed_command ?? NOT_SET} />
          <Setting name="agent_args" value={settings.agent_args || NOT_SET} />
          <Setting name="sandbox" value={String(settings.sandbox)} />
          <Setting name="open_from" value={settings.open_from} resolved={settings.open_from_path} />
          <Setting name="agent_timeout_minutes" value={settings.agent_timeout_minutes} />
          <Setting name="stages" value={settings.stages} resolved={settings.stages_path} />
        </dl>
      ) : null}
    </div>
  );
}
