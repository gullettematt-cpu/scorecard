// Placeholder for the three screens that land in Step 2/3 (and the problem sheet).
import { t } from '../i18n.js';
import { esc } from '../ui.js';
import { header } from '../app.js';

const emoji = { draw: '📷', approve: '✅', vi: '💬', problem: '⚠️' };
export function renderSoon(root, ctx, which) {
  root.innerHTML = `${header(ctx, '')}
    <div class="soon">
      <div class="big">${emoji[which] || '🛠️'}</div>
      <h1>${esc(t('soon.title'))}</h1>
      <p>${esc(t('soon.' + which))}</p>
      <div class="stack" style="margin-top:24px"><a class="act" href="javascript:history.back()">${esc(t('soon.back'))}</a></div>
    </div>`;
}
