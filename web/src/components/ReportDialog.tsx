import { useState } from 'preact/hooks';
import { REPORT_REASONS } from '../../../shared/taxonomy';
import type { Report } from '../../../shared/types';
import { ApiError, api } from '../lib/api';
import { t } from '../lib/i18n';
import { toast } from '../lib/store';
import { Field, Modal } from './ui';

export function ReportDialog({ targetType, targetId, label, onClose }: { targetType: Report['targetType']; targetId: string; label: string; onClose: () => void }) {
  const [reason, setReason] = useState(targetType === 'version' ? 'malware' : 'spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/reports', { targetType, targetId, reason, details });
      toast('success', t('Report sent'), t('Thanks. A moderator will look at it.'));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Could not send the report.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Report {name}', { name: label })}
      description={t('Reports go to the moderation team. Please include enough detail for us to act.')}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="report-form" class="btn btn-danger" disabled={busy || details.trim().length < 10}>
            {busy ? t('Sending…') : t('Send report')}
          </button>
        </>
      }
    >
      <form id="report-form" class="stack" onSubmit={submit}>
        <Field label={t('Reason')}>
          {(id) => (
            <select id={id} class="select" value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
              {REPORT_REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {t(r.label)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('Details')} hint={t('At least 10 characters. Links to evidence help.')} error={error ?? undefined}>
          {(id, d) => <textarea id={id} class="textarea" rows={5} maxLength={3000} value={details} aria-describedby={d} onInput={(e) => setDetails(e.currentTarget.value)} />}
        </Field>
      </form>
    </Modal>
  );
}
