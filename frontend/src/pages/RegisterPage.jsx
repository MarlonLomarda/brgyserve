import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client';

const INITIAL = {
  username: '',
  email: '',
  password: '',
  first_name: '',
  middle_name: '',
  last_name: '',
  suffix: '',
  birthdate: '',
  address: '',
  contact_number: '',
};

function Field({ label, name, value, onChange, type = 'text', required = false, ...rest }) {
  return (
    <label>
      {label} {!required && <span className="hint">(optional)</span>}
      <input type={type} name={name} value={value} onChange={onChange} required={required} {...rest} />
    </label>
  );
}

export default function RegisterPage() {
  const [form, setForm] = useState(INITIAL);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v.trim()])
      );
      const data = await apiFetch('/auth/register', { method: 'POST', body: payload });
      setSuccess(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="auth-page">
        <div className="card">
          <h1>Registration received</h1>
          <div className="alert success">{success}</div>
          <p>
            The Barangay Secretary will verify your information against the
            barangay&apos;s resident records. You can sign in once your account
            has been approved.
          </p>
          <Link className="button-link" to="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card wide" onSubmit={handleSubmit}>
        <h1>Resident Registration</h1>
        <p className="subtitle">
          BrgyServe — Barangay Ubujan, Tagbilaran City. Your account will be
          reviewed by the Barangay Secretary before you can sign in.
        </p>

        {error && <div className="alert error">{error}</div>}

        <h2>Login details</h2>
        <Field label="Username" name="username" value={form.username} onChange={handleChange} required autoComplete="username" />
        <Field label="Email" name="email" type="email" value={form.email} onChange={handleChange} required autoComplete="email" />
        <Field label="Password" name="password" type="password" value={form.password} onChange={handleChange} required minLength={8} autoComplete="new-password" />

        <h2>Personal information</h2>
        <div className="grid-2">
          <Field label="First name" name="first_name" value={form.first_name} onChange={handleChange} required />
          <Field label="Middle name" name="middle_name" value={form.middle_name} onChange={handleChange} />
          <Field label="Last name" name="last_name" value={form.last_name} onChange={handleChange} required />
          <Field label="Suffix" name="suffix" value={form.suffix} onChange={handleChange} placeholder="Jr., Sr., III" />
        </div>
        <Field label="Birthdate" name="birthdate" type="date" value={form.birthdate} onChange={handleChange} />
        <Field label="Address" name="address" value={form.address} onChange={handleChange} required placeholder="House no., street, purok, barangay, city" />
        <Field label="Contact number" name="contact_number" value={form.contact_number} onChange={handleChange} placeholder="09XXXXXXXXX" />

        <button type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Register'}
        </button>

        <p className="alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
