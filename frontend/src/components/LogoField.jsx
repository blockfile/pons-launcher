import { useEffect, useRef, useState } from 'react';
import { uploadLogo } from '../api.js';

// Mirrors ponsfamily's own create form: the same accepted types, the same 5 MB
// ceiling and the same acknowledgement before the picker unlocks. Checked here
// too so an oversized file fails instantly instead of after a round trip.
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

export default function LogoField({ value, onChange, onUploading }) {
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const objectUrl = useRef('');

  // Object URLs leak until revoked, and this component outlives many picks.
  function showPreview(url) {
    if (objectUrl.current && objectUrl.current !== url) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url.startsWith('blob:') ? url : '';
    setPreview(url);
  }
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    []
  );

  function clear() {
    showPreview('');
    setFileName('');
    setError('');
    onChange('');
  }

  // A failed pick discards whatever logo was set: f.logo is already cleared, so
  // the thumbnail must go with it, or the field shows an image that no longer
  // backs the value the launch would use.
  function fail(message) {
    showPreview('');
    setFileName('');
    onChange('');
    setError(message);
  }

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    onChange('');
    if (!ACCEPT.includes(file.type)) return fail('Use a PNG, JPEG or WebP image.');
    if (!file.size) return fail('The image is empty.');
    if (file.size > MAX_BYTES) return fail('Images must be smaller than 5 MB.');

    showPreview(URL.createObjectURL(file));
    setFileName(file.name);
    setBusy(true);
    onUploading(true);
    try {
      const { uri, gatewayUrl } = await uploadLogo(file);
      onChange(uri);
      showPreview(gatewayUrl);
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(false);
      onUploading(false);
    }
  }

  return (
    // A div, not a label: the confirm checkbox below gets its own label instead,
    // so clicking the caption/thumbnail/hint text can't toggle it off.
    <div className="wide logo">
      Logo
      <label className="logoConfirm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I understand that selected artwork will be moderated and uploaded to public IPFS.
      </label>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        onChange={pick}
        style={{ display: 'none' }}
      />
      <span className="logoBox">
        {preview ? <img className="logoThumb" src={preview} alt="" /> : <span className="logoThumb empty" />}
        <span className="logoMeta">
          <button
            type="button"
            className="ghost"
            disabled={!confirmed || busy}
            onClick={() => input.current.click()}
          >
            {busy ? 'Uploading image…' : confirmed ? (value ? 'Replace image' : 'Choose image') : 'Confirm public upload first'}
          </button>
          <span className="hint">
            {error ? <span className="logoError">{error}</span> : value || `${fileName || 'PNG, JPEG or WebP'} · 5 MB max`}
          </span>
        </span>
        {value && !busy && (
          <button type="button" className="ghost" onClick={clear}>
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
