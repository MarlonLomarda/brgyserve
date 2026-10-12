// Pages of a list (the Payments page, PaymentsPage.jsx). No React.

export const PAGE_SIZE = 25;

// Where page `page` of `count` rows starts and ends. The page asked for is
// clamped to the pages there are, so a list that shrank under it lands on
// its last page; anything below 1, or not a number, is page 1. `show` is
// false when everything fits on one page, and the pager is then hidden.
export function pageOf(count, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(count / size));
  const asked = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(asked, 1), pages);
  const start = (current - 1) * size;
  return {
    page: current,
    pages,
    start,
    end: Math.min(start + size, count),
    count,
    show: pages > 1,
  };
}

// The pager's two lines: "Page 2 of 4" and "Showing 26–50 of 88".
export function pagerText(p) {
  const n = (value) => value.toLocaleString("en-US");
  return {
    page: `Page ${n(p.page)} of ${n(p.pages)}`,
    range: `Showing ${n(p.count ? p.start + 1 : 0)}–${n(p.end)} of ${n(p.count)}`,
  };
}
