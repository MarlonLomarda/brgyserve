import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CHART_COLORS,
  formatCount,
  formatPeso,
  humanize,
  monthLabel,
} from '../constants/reports';

// Presentational report renderers. Deliberately free of auth, routing and
// import.meta.env so they are pure functions of their data — which is what
// makes them directly testable (see the render test) after a shape mismatch
// once blanked two whole reports.
//
// Each renderer reads ONLY the keys its own endpoint returns; handing it
// another report's payload will throw, which is why ReportsPage tags the
// fetched payload with the report it belongs to.

function Headline({ label, value }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="chart-card" data-pdf-block>
      <h4>{title}</h4>
      <div className="chart-area">
        <ResponsiveContainer width="100%" height={260}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DataTable({ title, columns, rows }) {
  return (
    <div data-pdf-block>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">No data for this period.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {/* columns is a MIXED array: plain strings for text columns,
                    num()-wrapped objects for numeric ones. The key needs the
                    same normalisation the cell content below already uses —
                    keyed on the object itself, every numeric column
                    stringifies to "[object Object]" and they collide. */}
                {columns.map((c) => (
                  <th key={c.label ?? c} className={c.numeric ? 'num' : ''}>
                    {c.label ?? c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className={columns[j]?.numeric ? 'num' : ''}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const num = (label) => ({ label, numeric: true });

// --- per-report rendering --------------------------------------------------
export function DocumentRequestsReport({ data }) {
  const monthly = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const byStatus = data.by_status.map((s) => ({ ...s, label: humanize(s.status) }));
  return (
    <>
      <div className="stat-row" data-pdf-block>
        {Object.entries(data.totals).map(([k, v]) => (
          <Headline key={k} label={humanize(k)} value={formatCount(v)} />
        ))}
      </div>

      <ChartCard title="Requests per month">
        <LineChart data={monthly} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Line type="monotone" dataKey="count" name="Requests" stroke={CHART_COLORS[0]} strokeWidth={2} />
        </LineChart>
      </ChartCard>

      <ChartCard title="Requests by status">
        <BarChart data={byStatus} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="count" name="Requests">
            {byStatus.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Requests by document type">
        <BarChart data={data.by_type} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="count" name="Requests" fill={CHART_COLORS[1]} />
        </BarChart>
      </ChartCard>

      <DataTable
        title="By status"
        columns={['Status', num('Requests')]}
        rows={byStatus.map((r) => [r.label, formatCount(r.count)])}
      />
      <DataTable
        title="By document type"
        columns={['Document type', num('Requests')]}
        rows={data.by_type.map((r) => [r.name, formatCount(r.count)])}
      />
      <DataTable
        title="Monthly"
        columns={['Month', num('Requests')]}
        rows={monthly.map((r) => [r.label, formatCount(r.count)])}
      />
    </>
  );
}

export function ResidentsReport({ data }) {
  const monthly = data.monthly_registrations.map((m) => ({ ...m, label: monthLabel(m.month) }));
  return (
    <>
      <div className="stat-row" data-pdf-block>
        {Object.entries(data.totals).map(([k, v]) => (
          <Headline key={k} label={humanize(k)} value={formatCount(v)} />
        ))}
      </div>

      <ChartCard title="New registrations per month">
        <LineChart data={monthly} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Line type="monotone" dataKey="count" name="Registrations" stroke={CHART_COLORS[4]} strokeWidth={2} />
        </LineChart>
      </ChartCard>

      <ChartCard title="Active residents by civil status">
        <BarChart data={data.by_civil_status} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="value" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="count" name="Residents">
            {data.by_civil_status.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <DataTable
        title="By sex (active residents)"
        columns={['Sex', num('Residents')]}
        rows={data.by_sex.map((r) => [r.value, formatCount(r.count)])}
      />
      <DataTable
        title="By civil status (active residents)"
        columns={['Civil status', num('Residents')]}
        rows={data.by_civil_status.map((r) => [r.value, formatCount(r.count)])}
      />
      <DataTable
        title="New registrations per month"
        columns={['Month', num('Registrations')]}
        rows={monthly.map((r) => [r.label, formatCount(r.count)])}
      />
    </>
  );
}

export function FacilityReport({ data }) {
  const monthly = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const byStatus = data.by_status.map((s) => ({ ...s, label: humanize(s.status) }));
  return (
    <>
      <div className="stat-row" data-pdf-block>
        {Object.entries(data.totals).map(([k, v]) => (
          <Headline key={k} label={humanize(k)} value={formatCount(v)} />
        ))}
      </div>

      {(data.most_used || data.never_used.length > 0) && (
        <div className="alert info" data-pdf-block>
          {data.most_used && (
            <>
              Most used: <strong>{data.most_used.name}</strong> ({formatCount(data.most_used.bookings)} bookings).{' '}
            </>
          )}
          {data.least_used && data.least_used.name !== data.most_used?.name && (
            <>
              Least used: <strong>{data.least_used.name}</strong> ({formatCount(data.least_used.bookings)}).{' '}
            </>
          )}
          {data.never_used.length > 0 && <>Never booked this period: {data.never_used.join(', ')}.</>}
        </div>
      )}

      <ChartCard title="Bookings per month">
        <LineChart data={monthly} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Line type="monotone" dataKey="count" name="Bookings" stroke={CHART_COLORS[2]} strokeWidth={2} />
        </LineChart>
      </ChartCard>

      <ChartCard title="Bookings per item">
        <BarChart data={data.by_item} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="bookings" name="Bookings" fill={CHART_COLORS[0]} />
        </BarChart>
      </ChartCard>

      <DataTable
        title="By item (cancelled bookings excluded)"
        columns={['Item', 'Type', num('Bookings'), num('Units booked')]}
        rows={data.by_item.map((r) => [r.name, r.type, formatCount(r.bookings), formatCount(r.units_booked)])}
      />
      <DataTable
        title="By status"
        columns={['Status', num('Bookings')]}
        rows={byStatus.map((r) => [r.label, formatCount(r.count)])}
      />
      <DataTable
        title="Monthly"
        columns={['Month', num('Bookings')]}
        rows={monthly.map((r) => [r.label, formatCount(r.count)])}
      />
    </>
  );
}

export function CollectionsReport({ data }) {
  const monthly = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const moneyKeys = ['total_collected', 'total_outstanding', 'total_billed', 'voided_amount'];
  return (
    <>
      <div className="stat-row" data-pdf-block>
        {Object.entries(data.totals).map(([k, v]) => (
          <Headline key={k} label={humanize(k)} value={moneyKeys.includes(k) ? formatPeso(v) : formatCount(v)} />
        ))}
      </div>

      <ChartCard title="Collected vs billed per month">
        <LineChart data={monthly} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => formatPeso(v)} />
          <Legend />
          <Line type="monotone" dataKey="collected" name="Collected" stroke={CHART_COLORS[4]} strokeWidth={2} />
          <Line type="monotone" dataKey="billed" name="Billed" stroke={CHART_COLORS[3]} strokeWidth={2} />
        </LineChart>
      </ChartCard>

      <ChartCard title="Collected vs outstanding by charge type">
        <BarChart data={data.by_type} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="charge_type" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => formatPeso(v)} />
          <Legend />
          <Bar dataKey="collected" name="Collected" fill={CHART_COLORS[4]} />
          <Bar dataKey="outstanding" name="Outstanding" fill={CHART_COLORS[3]} />
        </BarChart>
      </ChartCard>

      <DataTable
        title="By charge type"
        columns={['Charge type', num('Charges'), num('Collected'), num('Outstanding')]}
        rows={data.by_type.map((r) => [r.charge_type, formatCount(r.charges), formatPeso(r.collected), formatPeso(r.outstanding)])}
      />
      <DataTable
        title="By payment method (verified payments)"
        columns={['Method', num('Payments'), num('Amount')]}
        rows={data.by_payment_method.map((r) => [r.payment_method, formatCount(r.payments), formatPeso(r.amount)])}
      />
      <DataTable
        title="Monthly"
        columns={['Month', num('Collected'), num('Billed')]}
        rows={monthly.map((r) => [r.label, formatPeso(r.collected), formatPeso(r.billed)])}
      />
    </>
  );
}

export const RENDERERS = {
  'document-requests': DocumentRequestsReport,
  residents: ResidentsReport,
  'facility-utilization': FacilityReport,
  collections: CollectionsReport,
};

// Is there anything at all to show for this range?
export function isEmpty(key, data) {
  const t = data?.totals;
  if (!t) return true;
  if (key === 'document-requests') return t.total_requests === 0;
  if (key === 'facility-utilization') return t.total_bookings === 0;
  if (key === 'collections') return t.paid_charges === 0 && t.unpaid_charges === 0;
  if (key === 'residents') return t.active_residents === 0 && t.archived_residents === 0;
  return false;
}
