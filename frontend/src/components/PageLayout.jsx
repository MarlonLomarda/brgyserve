import { NavLink } from "react-router-dom";
import DashHeader from "./DashHeader";

function PageLayout({ title, subtitle, nav = [], children }) {
  return (
    <div className="page-layout">
      <DashHeader title={title} subtitle={subtitle} nav={nav} />

      {/* side bar for screens above 762px or medium screen size and above*/}
      <div id="side-bar">
        <div id="side-bar-expanded">
          {nav.map((item) => {
            const Icon = item.icon;

            return (
              <NavLink
                className={({ isActive }) =>
                  `side-bar-item ${isActive ? "active" : ""}`
                }
                key={item.to}
                to={item.to}
                end={item.end}
              >
                {Icon && <Icon size={18} />}
                <span className="side-bar-label">{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </div>

      <main className="page-content">{children}</main>
    </div>
  );
}

export default PageLayout;
