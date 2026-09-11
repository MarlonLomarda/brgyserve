import DashHeader from "./DashHeader";

function PageLayout({ dashTitle, dashSubtitle, navItems, children }) {
  return (
    <div className="dash">
      <DashHeader title={dashTitle} subtitle={dashSubtitle} nav={navItems} />
      <main className="dash-main">{children}</main>
    </div>
  );
}

export default PageLayout;
