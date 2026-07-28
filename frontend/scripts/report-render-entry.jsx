// Entry bundled by scripts/test-report-render.js. Kept separate so the test
// can MOUNT the real report components — the API-only tests never rendered
// them, which is how a cross-report data mix-up shipped and blanked two
// reports in the browser.
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';
import {
  DocumentRequestsReport,
  ResidentsReport,
  FacilityReport,
  CollectionsReport,
  RENDERERS,
  isEmpty,
} from '../src/components/ReportRenderers.jsx';

const RENDER = {
  'document-requests': DocumentRequestsReport,
  residents: ResidentsReport,
  'facility-utilization': FacilityReport,
  collections: CollectionsReport,
};

// Server-render one report. Returns { ok, html, error }.
globalThis.renderReport = (key, data) => {
  try {
    const Comp = RENDER[key];
    if (!Comp) return { ok: false, error: `no renderer for ${key}` };
    return { ok: true, html: renderToStaticMarkup(<Comp data={data} />) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// REAL client mount in jsdom. React error boundaries do NOT catch during
// server rendering, so boundary behaviour can only be verified this way.
globalThis.mountGuarded = async (key, data, container) => {
  const Comp = RENDER[key];
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ErrorBoundary resetKey={key}>
        <Comp data={data} />
      </ErrorBoundary>
    );
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
};

globalThis.rendererKeys = Object.keys(RENDERERS);
globalThis.isEmptyFn = isEmpty;
