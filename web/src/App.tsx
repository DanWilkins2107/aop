import { Link, Route, Routes } from "react-router-dom";
import { useLiveStatus } from "./lib/live.js";
import { GraphPage } from "./pages/GraphPage.js";
import { NodePage } from "./pages/NodePage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";

const STATUS_LABEL = { connecting: "Connecting", live: "Live", offline: "Reconnecting" };

function LiveIndicator() {
  const status = useLiveStatus();
  return (
    <span className={`live live-${status}`} title="Updates from the server">
      <span className="live-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
            <path d="M16 9 9 23M16 9l7 14" stroke="#868e96" strokeWidth="2" />
            <circle cx="16" cy="8" r="5" fill="#ffc107" />
            <circle cx="8" cy="24" r="5" fill="#5c7cfa" />
            <circle cx="24" cy="24" r="5" fill="#12b886" />
          </svg>
          AOP
        </Link>
        <span className="topbar-spacer" />
        <LiveIndicator />
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/p/:projectId" element={<GraphPage />} />
          <Route path="/n/:nodeId" element={<NodePage />} />
          <Route
            path="*"
            element={
              <div className="page">
                <h1>Page not found</h1>
                <Link to="/">Back to projects</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
