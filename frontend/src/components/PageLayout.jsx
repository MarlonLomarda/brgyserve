import DashHeader from "./DashHeader";

function PageLayout({ dashTitle, dashSubtitle, navItems, children }) {
  return (
    <div className="dash">
      <DashHeader title={dashTitle} subtitle={dashSubtitle} nav={navItems} />
      <main className="dash-main">
        <div>
          <section className="page-title">
            <h1>{dashTitle}</h1>
            <span>{dashSubtitle}</span>
          </section>
        </div>
        {children}
      </main>
    </div>
  );
}

export default PageLayout;
