import { useEffect, useState } from "react";
import type { LogTail, NodeView, RunView } from "../../../../src/shared/api.js";
import { api, failureText, urls } from "../../lib/api.js";
import { Part } from "./Part.js";
import { formatDuration, formatStart, formatTokens, humanize, runEnding, shortRunId } from "../../lib/format.js";

/** How often a running run's row and log tail are read again. Its output doesn't go through the change feed. */
const POLL_MS = 2_000;

interface Loaded {
  runs: RunView[];
  tail: LogTail | null;
  tailError: string | null;
}

async function load(nodeId: string): Promise<Loaded> {
  const runs = await api.runs(nodeId);
  const latest = runs[0];
  if (!latest) return { runs, tail: null, tailError: null };
  try {
    return { runs, tail: await api.logTail(latest.id), tailError: null };
  } catch (error) {
    return { runs, tail: null, tailError: failureText(error) };
  }
}

function RunRow({ run, now }: { run: RunView; now: number }) {
  const end = run.ended_at === null ? now : new Date(run.ended_at).getTime();
  const context = run.context_tokens === null ? "No context reported" : `${run.context_tokens} tokens of context`;
  const output = run.output_tokens === null ? "" : `, ${run.output_tokens} output tokens`;
  return (
    <tr>
      <td title={`Run ${run.id}`}>{humanize(run.stage)}</td>
      <td title={run.started_at}>{formatStart(run.started_at)}</td>
      <td>{formatDuration(end - new Date(run.started_at).getTime())}</td>
      <td>{runEnding(run.ending)}</td>
      <td className="num" title={`${context}${output}`}>
        {formatTokens(run.context_tokens)}
      </td>
    </tr>
  );
}

/** Every agent run on the node, newest first, then the end of the latest one's log, collapsed until wanted. */
export function Runs({ node }: { node: NodeView }) {
  const [state, setState] = useState<{ nodeId: string; loaded: Loaded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = state?.nodeId === node.id ? state.loaded : null;
  const running = loaded?.runs[0]?.ending === "running";

  // Read again whenever the node changes, which includes a run starting or ending.
  useEffect(() => {
    let live = true;
    load(node.id).then(
      (next) => {
        if (!live) return;
        setState({ nodeId: node.id, loaded: next });
        setError(null);
      },
      (failure: unknown) => live && setError(failureText(failure)),
    );
    return () => {
      live = false;
    };
  }, [node]);

  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      load(node.id).then(
        (next) => live && setState({ nodeId: node.id, loaded: next }),
        () => {},
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, node.id]);

  if (error && !loaded) return <p className="muted runs-note">Runs couldn't be loaded: {error}</p>;
  if (!loaded) return null;
  if (loaded.runs.length === 0) return <p className="muted runs-note">No agent runs yet.</p>;

  const now = Date.now();
  const latest = loaded.runs[0] as RunView;
  return (
    <div className="runs">
      <h3>Runs</h3>
      <div className="runs-scroll">
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
              <th scope="col">Ended</th>
              <th scope="col" className="num" title="Context consumed: the size of the run's latest turn, in tokens">
                Context
              </th>
            </tr>
          </thead>
          <tbody>
            {loaded.runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      <Part title={`Latest log, run ${shortRunId(latest.id)}`}>
        <p className="log-tail-head">
          <a href={urls.runLog(latest.id)} target="_blank" rel="noreferrer" className="muted">
            Full log
          </a>
        </p>
        {loaded.tail ? (
          loaded.tail.lines.length > 0 ? (
            <pre className="log-tail" aria-label="Last 20 lines of the latest run's log">
              {loaded.tail.lines.join("\n")}
            </pre>
          ) : (
            <p className="muted runs-note">Nothing logged yet.</p>
          )
        ) : (
          <p className="muted runs-note">{loaded.tailError ?? "No log."}</p>
        )}
      </Part>
    </div>
  );
}
