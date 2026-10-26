import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// A strip of tabs that filters a list already loaded, each tab with its
// count: the Payments page's type tabs (PaymentsPage.jsx), lifted out so that
// other lists can use them. The Document requests list's status tabs are the
// first; Rental bookings is next. The markup, the classes and the behaviour
// are the Payments strip's, and so is the look: index.css's .pay-tabs rules
// are scoped to these classes, not to a page.
//
// - Toggle buttons in a group, aria-pressed on the chosen one. No page here
//   uses role="tab". `label` names the group.
// - A tab with nothing in it is dimmed (.pay-tab-empty), never disabled:
//   pressing it shows its empty list.
// - Where the tabs do not fit (a narrow phone), the strip scrolls inside
//   itself, with no scrollbar, and data-fade names the ends with tabs past
//   them, which index.css fades.
// - The chosen tab, and a tab that takes focus, is brought fully into view,
//   clear of a faded end, by moving the strip and never the page.
//
// `tabs` is [{ key, label }] in order, `counts` holds each key's count,
// `active` is the chosen key, and `onChoose(key)` is called with the key of
// the tab pressed.

// The width of the faded ends. A chosen tab is scrolled this far clear of a
// faded end. COUPLED to the 24px in index.css's .pay-tabs[data-fade] masks,
// and to TAB_FADE in PaymentsPage.jsx, its first copy; no CSS variable binds
// the three.
const TAB_FADE = 24;

export default function ListTabs({ label, tabs, counts, active, onChoose }) {
  const stripRef = useRef(null);

  // Brings a tab fully into view in the strip, clear of a faded end. Only the
  // strip moves: scrollIntoView would scroll the page as well.
  const reveal = useCallback((button) => {
    const strip = stripRef.current;
    if (!strip || !button) return;
    const s = strip.getBoundingClientRect();
    const t = button.getBoundingClientRect();
    const start = s.left + (strip.scrollLeft > 0 ? TAB_FADE : 0);
    const more = strip.scrollLeft + strip.clientWidth < strip.scrollWidth;
    const end = s.right - (more ? TAB_FADE : 0);
    if (t.left < start) strip.scrollLeft -= start - t.left;
    else if (t.right > end) strip.scrollLeft += t.right - end;
  }, []);

  // The chosen tab, when it changes and whenever the strip is drawn again (a
  // page leaves it out while its list loads); before paint, so nothing
  // jumps. A tab that takes focus is revealed too (its onFocus): a browser
  // scrolls a focused element into view only when none of it shows, and
  // leaves one half under the fade.
  useLayoutEffect(() => {
    reveal(stripRef.current?.querySelector('[aria-pressed="true"]'));
  }, [active, reveal]);

  // Which ends of the strip have tabs past them, for index.css to fade:
  // "start", "end", both, or "" while the tabs fit. Measured after every
  // render (new counts change the tabs' widths), on the strip's own scroll
  // and on a resize; stored only when it changes.
  const [fade, setFade] = useState("");
  const measureFade = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const ends = [];
    if (strip.scrollLeft > 1) ends.push("start");
    if (strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1) {
      ends.push("end");
    }
    setFade(ends.join(" "));
  }, []);
  useLayoutEffect(() => {
    measureFade();
  });
  useEffect(() => {
    window.addEventListener("resize", measureFade);
    return () => window.removeEventListener("resize", measureFade);
  }, [measureFade]);

  return (
    <div
      ref={stripRef}
      className="pay-tabs"
      role="group"
      aria-label={label}
      data-fade={fade || undefined}
      onScroll={measureFade}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`pay-tab${counts[t.key] === 0 ? " pay-tab-empty" : ""}`}
          aria-pressed={active === t.key}
          onClick={() => onChoose(t.key)}
          onFocus={(e) => reveal(e.currentTarget)}
        >
          {t.label}{" "}
          <span className="pay-tab-count">
            {counts[t.key].toLocaleString("en-US")}
          </span>
        </button>
      ))}
    </div>
  );
}
