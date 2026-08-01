import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

// Debounced search over the resident master list, used wherever a screen needs
// the user to point at an existing resident (blotter parties, household head).
// One implementation so the search behaviour is identical everywhere.
//
// `value` is the picked resident as { resident_id, label, ... }; passing a
// value switches the control into its "selected" state.
export function residentName(r) {
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
}

export default function ResidentPicker({ value, onPick, onClear, placeholder }) {
  const { authFetch } = useAuth();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value || term.trim().length < 2) {
      setResults(null);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await authFetch(`/resident-records?search=${encodeURIComponent(term.trim())}&per_page=8`);
        if (!cancelled) setResults(data.records);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, value, authFetch]);

  if (value) {
    return (
      <div className="picker-selected">
        <span>
          <strong>{value.label}</strong> <span className="muted">(record #{value.resident_id})</span>
        </span>
        <button type="button" className="btn secondary" onClick={onClear}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={placeholder || 'Search the resident master list…'}
      />
      {term.trim().length >= 2 && (
        <div className="picker-results">
          {searching && <p className="muted">Searching…</p>}
          {results && results.length === 0 && !searching && (
            <p className="muted">No matching residents.</p>
          )}
          {results?.map((r) => (
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
