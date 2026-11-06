import type { ReactNode } from "react";
import { ProblemBanner } from "../components/ErrorNotice.js";
import { SubPage } from "../components/SubPage.js";
import { api } from "../lib/api.js";
import { useLiveData } from "../lib/live.js";

function Setting({ name, about, value, resolved }: { name: string; about: ReactNode; value: ReactNode; resolved?: string }) {
  return (
    <div className="setting">
      <dt>{name}</dt>
      <dd className="setting-about">{about}</dd>
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

/** Read-only by design: agents can reach the API, so nothing here can change commands. */
export function AopSettingsPage() {
  const { data, error } = useLiveData(() => api.config(), "config");
  const settings = data?.settings;
  return (
    <SubPage title="AOP settings" error={error}>
      {data ? (
        <p className="settings-note">
          Read-only. To change these, edit <code>{data.config_path}</code>.
        </p>
      ) : null}
      {data && data.problems.length > 0 ? (
        <ProblemBanner title="The AOP config is invalid" problems={data.problems} />
      ) : null}
      {settings ? (
        <dl className="settings-list">
          <Setting
            name="Agent session command"
            about="This is the session your agents are starting in. Strongly consider having this command start sessions inside a sandbox."
            value={settings.agent_session_command}
          />
          <Setting
            name="Out of sandbox command"
            about={
              <>
                Sometimes you may need to run and supervise a session that runs outside of a sandbox (using{" "}
                <code>aop steer --no-sandbox</code>). Not needed if you're not running sessions sandboxed.
              </>
            }
            value={settings.out_of_sandbox_command ?? NOT_SET}
          />
          <Setting
            name="Open from"
            about="Where sessions start for projects with no path."
            value={settings.open_from}
            resolved={settings.open_from_path}
          />
          <Setting
            name="Agent timeout"
            about={
              <>
                How long an agent can run before it's stopped and its node goes to <code>failed</code>.
              </>
            }
            value={`${settings.agent_timeout_minutes} minutes`}
          />
          <Setting
            name="Stages"
            about="The file that defines your process."
            value={settings.stages}
            resolved={settings.stages_path}
          />
          <Setting
            name="Improvement stages"
            about="The pipeline that drafts, reviews and applies improvements to your skills and stage prompts."
            value={settings.improvement_stages ?? NOT_SET}
            {...(settings.improvement_stages_path ? { resolved: settings.improvement_stages_path } : {})}
          />
          <Setting
            name="Improvements path"
            about="The folder improvements may change, along with your stage prompts. Raise PR needs it inside a git repo."
            value={settings.improvements_path}
            resolved={settings.improvements_dir}
          />
        </dl>
      ) : null}
    </SubPage>
  );
}
