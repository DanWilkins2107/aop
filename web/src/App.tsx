import { Link, Route, Routes } from "react-router-dom";
import { useLiveStatus } from "./lib/live.js";
import { AopSettingsPage } from "./pages/AopSettingsPage.js";
import { GraphPage } from "./pages/GraphPage.js";
import { ImprovementsPage } from "./pages/ImprovementsPage.js";
import { NodePage } from "./pages/NodePage.js";
import { ProcessPage } from "./pages/ProcessPage.js";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { RoadmapPage } from "./pages/RoadmapPage.js";

/**
 * Says nothing while the connection is healthy. The visible text is hidden from screen readers,
 * which hear it once from a polite status region that stays mounted so the change is announced.
 */
function ConnectionNotice() {
  const offline = useLiveStatus() === "offline";
  return (
    <>
      {offline ? (
        <span className="connection-notice" aria-hidden="true">
          Reconnecting
        </span>
      ) : null}
      <span className="visually-hidden" role="status">
        {offline ? "Reconnecting" : ""}
      </span>
    </>
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
        <Link to="/process" className="quiet-link">
          Process
        </Link>
        <Link to="/roadmap" className="quiet-link">
          Roadmap
        </Link>
        <Link to="/settings" className="quiet-link">
          AOP settings
        </Link>
        <ConnectionNotice />
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/improvements" element={<ImprovementsPage />} />
          <Route path="/settings" element={<AopSettingsPage />} />
          <Route path="/process" element={<ProcessPage />} />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/p/:projectId" element={<GraphPage />} />
          <Route path="/p/:projectId/settings" element={<ProjectSettingsPage />} />
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
