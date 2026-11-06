import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

/** Projects and Improvements, side by side at the top of the home page, with that tab's one action. */
export function HomeTabs({ action }: { action: ReactNode }) {
  const tab = ({ isActive }: { isActive: boolean }) => `home-tab${isActive ? " home-tab-active" : ""}`;
  return (
    <div className="projects-head">
      <nav className="home-tabs" aria-label="Home">
        <NavLink to="/" end className={tab}>
          Projects
        </NavLink>
        <NavLink to="/improvements" className={tab}>
          Improvements
        </NavLink>
      </nav>
      {action}
    </div>
  );
}
