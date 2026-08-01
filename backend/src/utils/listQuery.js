// Shared helpers for the paginated + searchable list endpoints, so the
// Households list behaves identically to the Resident Records list it mirrors
// rather than re-deriving the same rules slightly differently.

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;

// Search terms go into PostgREST .or() filter strings, where commas and
// parentheses are syntax and %/_ are LIKE wildcards — neutralize all of them
// so user input can't break (or game) the filter.
const sanitizeTerm = (term) => term.replace(/[,()%_\\]/g, ' ').trim();

// Splits a search box into the words that must ALL match (each word is applied
// as its own .or() group, and chained .or() calls AND together). Capped so a
// pasted paragraph can't turn into an unbounded pile of filters.
const searchWords = (raw, limit = 5) =>
  String(raw ?? '')
    .split(/\s+/)
    .map(sanitizeTerm)
    .filter(Boolean)
    .slice(0, limit);

function parsePaging(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(query.per_page) || DEFAULT_PER_PAGE));
  const from = (page - 1) * perPage;
  return { page, perPage, from, to: from + perPage - 1 };
}

// PGRST103 = the requested range is past the end of the result set. That is an
// empty page, not a server error.
const isRangeError = (error) => error?.code === 'PGRST103';

const pageResponse = (key, rows, count, page, perPage) => ({
  [key]: rows,
  total: count || 0,
  page,
  per_page: perPage,
  total_pages: Math.ceil((count || 0) / perPage),
});

module.exports = {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  sanitizeTerm,
  searchWords,
  parsePaging,
  isRangeError,
  pageResponse,
};
