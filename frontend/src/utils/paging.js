// Pages of a list (the Payments page, PaymentsPage.jsx). No React.

// The Rows per page choices, and the one every visit starts with.
export const PAGE_SIZES = [10, 25, 50, 100];
export const PAGE_SIZE = 25;

// Where page `page` of `count` rows starts and ends, `size` rows a page (25
// when the size is not a whole number above 0). The page asked for is
// clamped to the pages there are, so a list that shrank under it lands on
// its last page; anything below 1, or not a number, is page 1. `show` is
// true from 11 rows, even when they fit on one page, so Rows per page stays
// within reach; at 10 or fewer every choice shows the whole list, and the
// pager is hidden.
export function pageOf(count, page, size = PAGE_SIZE) {
  const per = Number.isInteger(size) && size > 0 ? size : PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(count / per));
  const asked = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(asked, 1), pages);
  const start = (current - 1) * per;
  return {
    page: current,
    pages,
    size: per,
    start,
    end: Math.min(start + per, count),
    count,
    show: count > PAGE_SIZES[0],
  };
}

// The pager's words: the three numbers of "Showing 26 to 50 of 88 results",
// which the page writes out with each number in bold, and the phone's "Page
// 2 of 4".
export function pagerText(p) {
  const n = (value) => value.toLocaleString("en-US");
  return {
    from: n(p.count ? p.start + 1 : 0),
    to: n(p.end),
    of: n(p.count),
    page: `Page ${n(p.page)} of ${n(p.pages)}`,
  };
}

// Marks a gap in pageItems' list: drawn as "…", never as a button.
export const GAP = "gap";

// The page numbers to draw, in order, with GAP where pages are left out. Up
// to 7 pages, every number. Above 7, exactly 7 slots, the first and the last
// page always among them: pages 1 to 4 draw 1 2 3 4 5 … last; the last 4
// pages draw 1 … and the last 5; any other page draws 1 … page-1 page
// page+1 … last. So a gap always stands for at least two pages.
export function pageItems(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, GAP, pages];
  if (page >= pages - 3) {
    return [1, GAP, pages - 4, pages - 3, pages - 2, pages - 1, pages];
  }
  return [1, GAP, page - 1, page, page + 1, GAP, pages];
}
