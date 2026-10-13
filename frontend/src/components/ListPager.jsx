import { useId } from "react";
import { IoChevronBack, IoChevronForward } from "react-icons/io5";
import { GAP, PAGE_SIZES, pageItems, pagerText } from "../utils/paging";

// A list's pager: the Payments page's (PaymentsPage.jsx), lifted out so that
// other lists can use it. The Document requests list is the first; Rental
// bookings is next. The markup, the classes and the behaviour are the
// Payments pager's, and so is the look: index.css's .pay-pager rules are
// scoped to these classes, not to a page.
//
// - One bar, a nav named "Pagination": "Showing 26 to 50 of 77 results", its
//   figures in bold, announced when they change, because a press moves no
//   focus; Rows per page (10, 25, 50 or 100); then Previous, the page numbers
//   and Next. A phone shows "Page 2 of 4" between Previous and Next in place
//   of the numbers (index.css), so both are in the markup at every width.
// - Above 7 pages there are exactly 7 slots, the first and the last page
//   always among them, and a "…" for the pages left out, which is text,
//   never a button (utils/paging.js). The current page is filled and marked
//   aria-current="page".
// - Previous and Next are aria-disabled at the ends, not disabled, so the one
//   just pressed keeps focus when it reaches the end; a press on either
//   there, or on the current page, does nothing.
// - A page change, or a new Rows per page, brings the list's heading into
//   view, and nothing else moves: focus stays where it was.
// - At 10 matches or fewer it is not drawn: every Rows per page shows the
//   whole list (pageOf's `show`).
//
// `paging` is pageOf's answer for the rows (utils/paging.js); `onPage(n)` is
// called with the page pressed and `onSize(n)` with the Rows per page chosen,
// and the page keeps both, and decides when to go back to page 1.
// `headingRef`, when given, is the list's heading.
export default function ListPager({ paging, onPage, onSize, headingRef }) {
  const sizeId = useId();
  if (!paging.show) return null;
  const words = pagerText(paging);

  function showHeading() {
    headingRef?.current?.scrollIntoView({ block: "nearest" });
  }

  function goTo(n) {
    if (n < 1 || n > paging.pages || n === paging.page) return;
    onPage(n);
    showHeading();
  }

  function changeSize(value) {
    onSize(value);
    showHeading();
  }

  return (
    <nav className="pay-pager" aria-label="Pagination">
      <p className="pay-pager-count" aria-live="polite">
        Showing <strong>{words.from}</strong> to{" "}
        <strong>{words.to}</strong> of <strong>{words.of}</strong> results
      </p>
      <div className="pay-pager-size">
        <label htmlFor={sizeId}>Rows per page</label>
        <select
          id={sizeId}
          value={paging.size}
          onChange={(e) => changeSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="pay-pager-pages">
        <button
          type="button"
          className="btn secondary pay-pager-step"
          aria-disabled={paging.page === 1}
          onClick={() => goTo(paging.page - 1)}
        >
          <IoChevronBack aria-hidden="true" />
          Previous
        </button>
        <ul className="pay-pager-numbers">
          {pageItems(paging.page, paging.pages).map((item, i) =>
            item === GAP ? (
              <li key={`gap-${i}`} className="pay-pager-gap">
                …
              </li>
            ) : (
              <li key={item}>
                <button
                  type="button"
                  className="pay-page"
                  aria-label={`Page ${item}`}
                  aria-current={item === paging.page ? "page" : undefined}
                  onClick={() => goTo(item)}
                >
                  {item}
                </button>
              </li>
            ),
          )}
        </ul>
        <p className="pay-pager-short">{words.page}</p>
        <button
          type="button"
          className="btn secondary pay-pager-step"
          aria-disabled={paging.page === paging.pages}
          onClick={() => goTo(paging.page + 1)}
        >
          Next
          <IoChevronForward aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
