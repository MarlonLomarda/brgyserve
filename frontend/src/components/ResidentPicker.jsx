import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

// Debounced search over the resident master list, used wherever a screen needs
// the user to point at an existing resident (blotter parties, household head).
// One implementation so the search behaviour is identical everywhere.
//
// `value` is the picked resident as { resident_id, label, ... }; passing a
// value switches the control into its "selected" state.
//
// The box needs a name beyond its placeholder: a screen with a visible label
// passes `inputId` and gives the label htmlFor={inputId} (and className
// "picker-label"); a screen with none passes `ariaLabel`.
export function residentName(r) {
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
}

// Why a search failed, for "Could not search the resident list: …": the
// server's own sentence when it sent one, ending in a full stop either way.
function searchFailure(err) {
  const reason = (err?.message || 'the server could not be reached').trim();
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

export default function ResidentPicker({ value, onPick, onClear, placeholder, inputId, ariaLabel }) {
  const { authFetch } = useAuth();
  const ownId = useId();
  const inputRef = useRef(null);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  // A failed search is an error, never an empty answer: results stays null,
  // so "No matching residents." is said only when the server found none.
  const [error, setError] = useState(null);
  // Bumped by Try again, so the same words are asked once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    if (value || term.trim().length < 2) {
      setResults(null);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await authFetch(`/resident-records?search=${encodeURIComponent(term.trim())}&per_page=8`);
        if (!cancelled) setResults(data.records);
      } catch (err) {
        if (!cancelled) {
          setResults(null);
          setError(searchFailure(err));
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, value, attempt, authFetch]);

  if (value) {
    return (
      <div className="resident-picker picker-selected">
        <span>
          <strong>{value.label}</strong> <span className="muted">(record #{value.resident_id})</span>
        </span>
        <button type="button" className="btn secondary" onClick={onClear}>
          Change
        </button>
      </div>
    );
  }

  const asking = term.trim().length >= 2;
  let status = '';
  if (asking && searching) status = 'Searching…';
  else if (asking && results && results.length === 0) status = 'No matching residents.';

  return (
    <div className="resident-picker">
      <input
        ref={inputRef}
        id={inputId || ownId}
        aria-label={ariaLabel}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        // Enter here would submit the whole form around the picker (the
        // browser's implicit submission). A result is picked by a click, or
        // by Enter or Space on the result itself, which this does not touch.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        placeholder={placeholder || 'Search the resident master list…'}
      />
      {/* Always in the DOM, so a screen reader announces "Searching…" and
          "No matching residents." when they appear. */}
      <p className="muted picker-status" role="status">
        {status}
      </p>
      {asking && error && !searching && (
        <div className="picker-error">
          <p role="alert">Could not search the resident list: {error}</p>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              // The button goes once the search is out; the box keeps focus.
              inputRef.current?.focus();
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {asking && results?.length > 0 && (
        <div className="picker-results">
          {results.map((r) => (
            <button
              key={r.resident_id}
              type="button"
              className="picker-option"
              onClick={() => {
                // Carry the whole record: callers need more than the name
                // (the household form pre-fills the address from it).
                onPick({ ...r, label: residentName(r) });
                setTerm('');
              }}
            >
              <strong>{residentName(r)}</strong>{' '}
              <span className="muted">
                · {r.birthdate || 'no birthdate'} · {r.address}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
