function SearchBar({ search, onSearch, onClear, searchInput, onSearchInput }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
      className="head-actions"
    >
      <input
        value={searchInput}
        onChange={onSearchInput}
        placeholder="Search by head, member, address, or household #"
      />
      <button className="btn secondary" type="submit">
        Search
      </button>
      {search && (
        <button className="btn secondary" type="button" onClick={onClear}>
          Clear
        </button>
      )}
    </form>
  );
}

export default SearchBar;
