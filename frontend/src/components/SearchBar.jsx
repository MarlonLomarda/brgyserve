import { IoSearch } from "react-icons/io5";
import { IoClose } from "react-icons/io5";

function SearchBar({
  search,
  onSearch,
  onClear,
  searchInput,
  onSearchInput,
  placeholder,
}) {
  return (
    <form onSubmit={onSearch} className="searchbar">
      <input
        value={searchInput}
        onChange={onSearchInput}
        placeholder={placeholder}
      />
      <section>
        <button className="search-btn" type="submit">
          <IoSearch />
        </button>
        {search && (
          <button
            className="clear-search-btn secondary"
            type="button"
            onClick={onClear}
          >
            <IoClose />
          </button>
        )}
      </section>
    </form>
  );
}

export default SearchBar;
