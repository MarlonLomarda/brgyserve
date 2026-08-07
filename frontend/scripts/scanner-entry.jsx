// Entry point for test-scanner.cjs — bundles the REAL AttendanceScanner so
// Node can mount it. Exposes the module namespace too, so the test can read
// timing constants from the component rather than hardcoding its own copy.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AttendanceScanner, * as scannerModule from '../src/components/AttendanceScanner.jsx';

globalThis.act = act;
globalThis.scannerModule = scannerModule;
globalThis.mountScanner = async (container, props) => {
  const root = createRoot(container);
  await act(async () => {
    root.render(<AttendanceScanner {...props} />);
  });
  return root;
};
