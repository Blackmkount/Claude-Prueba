// Pie de la barra lateral: crédito a Bambuddy y enlace al código fuente
// (AGPL-3.0 §13). Se monta en Layout.tsx de Bambuddy (enganche BLACKFORGE).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2 } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { downloadSourceArchive, SourceUnavailableError } from '../api';
import { BLACKFORGE_NS } from '../i18n';

export function BlackForgeSidebarFooter() {
  const { t } = useTranslation(BLACKFORGE_NS);
  const { showToast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadSourceArchive();
    } catch (err) {
      showToast(err instanceof SourceUnavailableError ? t('source.unavailable') : t('source.error'), 'error');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="flex flex-col items-center gap-0.5 text-xs text-bambu-gray"
      data-testid="blackforge-sidebar-footer"
    >
      <a
        href="https://github.com/maziggy/bambuddy"
        target="_blank"
        rel="noopener noreferrer"
        className="whitespace-nowrap hover:text-white transition-colors"
      >
        {t('brand.basedOn', { project: 'Bambuddy' })}
      </a>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="inline-flex items-center gap-1 whitespace-nowrap hover:text-white transition-colors disabled:opacity-60"
        title={t('source.title')}
      >
        <FileCode2 className="w-3.5 h-3.5" aria-hidden="true" />
        {downloading ? t('source.downloading') : t('source.link')}
      </button>
    </div>
  );
}
