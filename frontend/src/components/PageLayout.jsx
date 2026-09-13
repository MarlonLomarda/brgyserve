import DashHeader from "./DashHeader";
import { useAuth } from "../auth/AuthContext";
import { useNavigate } from "react-router-dom";

function PageLayout({ dashTitle, dashSubtitle, navItems, children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="dash">
      <DashHeader
        title={dashTitle}
        subtitle={dashSubtitle}
        nav={navItems}
        user={user}
        handleLogout={() => handleLogout()}
      />
      <main className="dash-main">
        <div className="page-header-wrapper">
          <section className="page-title">
            <h1>{dashTitle}</h1>
            <span>{dashSubtitle}</span>
          </section>
          <button className="btn secondary" onClick={handleLogout}>
            Log out
          </button>
        </div>
        {children}
      </main>
    </div>
  );
}

export default PageLayout;
