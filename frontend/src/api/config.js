// The single definition of the API base URL.
//
// Two callers need it: the fetch wrapper in client.js, and the Reports CSV
// export, which calls fetch directly rather than going through authFetch. They
// used to declare it separately with the same fallback, so a deployment could
// have them disagree.
//
// The localhost fallback is a DEV-SERVER CONVENIENCE ONLY. A production build
// with VITE_API_URL unset used to succeed and quietly bake in localhost:5000 —
// the deploy went green and then every request failed in the browser, with
// nothing anywhere reporting why. That is now a build failure: see the guard in
// vite.config.js, which runs before this module is ever bundled. So by the time
// a production bundle exists, VITE_API_URL was set and this fallback is dead
// code there; it is reachable only under `vite dev`.
// The port must match backend/src/server.js (`process.env.PORT || 5000`) and
// the guidance in vite.config.js and .env.example, which both name 5000. This
// value is one side of a two-sided pair — changing it alone just points the
// dev frontend at a port nothing is listening on.
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
