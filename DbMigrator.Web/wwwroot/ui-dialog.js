/* ============================================================================
   UI DIALOG — modern replacement for window.alert / confirm / prompt
   ============================================================================ */

const UI_DIALOG_ICONS = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-xmark',
    question: 'fa-circle-question'
};

let uiDialogQueue = Promise.resolve();

function escapeDialogHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDialogMessage(message) {
    return escapeDialogHtml(message).replace(/\n/g, '<br>');
}

function inferDialogVariant(message, fallback = 'info') {
    const text = String(message || '');
    if (/^❌|gagal|error|tidak valid|tidak dapat/i.test(text)) return 'error';
    if (/^✅|sukses|berhasil|tersalin/i.test(text)) return 'success';
    if (/peringatan|PERINGATAN|tidak dapat dibatalkan|hati-hati/i.test(text)) return 'warning';
    return fallback;
}

function getDialogElements() {
    return {
        overlay: document.getElementById('ui-dialog-overlay'),
        card: document.getElementById('ui-dialog-card'),
        iconWrap: document.getElementById('ui-dialog-icon'),
        icon: document.getElementById('ui-dialog-icon-i'),
        title: document.getElementById('ui-dialog-title'),
        message: document.getElementById('ui-dialog-message'),
        inputWrap: document.getElementById('ui-dialog-input-wrap'),
        input: document.getElementById('ui-dialog-input'),
        inputHint: document.getElementById('ui-dialog-input-hint'),
        footer: document.getElementById('ui-dialog-footer')
    };
}

function enqueueDialog(task) {
    const run = uiDialogQueue.then(() => task());
    uiDialogQueue = run.catch(() => {});
    return run;
}

function closeUiDialog() {
    const { overlay } = getDialogElements();
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('ui-dialog-open');
}

function openUiDialog() {
    const { overlay } = getDialogElements();
    if (!overlay) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('ui-dialog-open');
}

function buildDialogButtons(buttons) {
    const { footer } = getDialogElements();
    if (!footer) return;
    footer.innerHTML = '';

    buttons.forEach((btn, index) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `ui-dialog-btn ${btn.className || 'ui-dialog-btn-secondary'}`;
        el.textContent = btn.label;
        el.addEventListener('click', btn.onClick);
        footer.appendChild(el);
        if (index === buttons.length - 1) {
            setTimeout(() => el.focus(), 50);
        }
    });
}

function showUiDialog(config) {
    return enqueueDialog(() => new Promise((resolve) => {
        const els = getDialogElements();
        if (!els.overlay) {
            console.error('[ui-dialog] Overlay element missing');
            resolve(config.fallbackValue);
            return;
        }

        const variant = config.variant || 'info';
        els.card.className = `ui-dialog-card ui-dialog-${variant}`;
        els.iconWrap.className = `ui-dialog-icon-wrap ui-dialog-icon-${variant}`;
        els.icon.className = `fa-solid ${UI_DIALOG_ICONS[variant] || UI_DIALOG_ICONS.info}`;

        els.title.textContent = config.title || 'Pemberitahuan';
        els.message.innerHTML = formatDialogMessage(config.message || '');

        const showInput = config.type === 'prompt';
        els.inputWrap.style.display = showInput ? 'block' : 'none';
        if (showInput) {
            els.input.value = config.defaultValue || '';
            els.input.placeholder = config.placeholder || '';
            if (config.inputHint) {
                els.inputHint.textContent = config.inputHint;
                els.inputHint.style.display = 'block';
            } else {
                els.inputHint.style.display = 'none';
            }
        }

        const finish = (value) => {
            closeUiDialog();
            els.overlay.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onKeyDown);
            resolve(value);
        };

        const onOverlayClick = (e) => {
            if (e.target === els.overlay && config.dismissible !== false) {
                finish(config.type === 'confirm' || config.type === 'prompt' ? false : undefined);
            }
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape' && config.dismissible !== false) {
                finish(config.type === 'confirm' || config.type === 'prompt' ? false : undefined);
            }
            if (e.key === 'Enter' && config.type === 'prompt' && document.activeElement === els.input) {
                e.preventDefault();
                footer.querySelector('.ui-dialog-btn-primary')?.click();
            }
        };

        els.overlay.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onKeyDown);

        if (config.type === 'alert') {
            buildDialogButtons([{
                label: config.confirmText || 'OK',
                className: 'ui-dialog-btn-primary',
                onClick: () => finish(true)
            }]);
        } else if (config.type === 'confirm') {
            buildDialogButtons([
                {
                    label: config.cancelText || 'Batal',
                    className: 'ui-dialog-btn-secondary',
                    onClick: () => finish(false)
                },
                {
                    label: config.confirmText || 'Ya, Lanjutkan',
                    className: config.danger ? 'ui-dialog-btn-danger' : 'ui-dialog-btn-primary',
                    onClick: () => finish(true)
                }
            ]);
        } else if (config.type === 'prompt') {
            buildDialogButtons([
                {
                    label: config.cancelText || 'Batal',
                    className: 'ui-dialog-btn-secondary',
                    onClick: () => finish(null)
                },
                {
                    label: config.confirmText || 'Konfirmasi',
                    className: 'ui-dialog-btn-primary',
                    onClick: () => {
                        const value = els.input.value.trim();
                        if (config.matchValue != null && value !== config.matchValue) {
                            els.input.classList.add('is-invalid');
                            els.inputHint.textContent = config.matchError || 'Input tidak cocok.';
                            els.inputHint.style.display = 'block';
                            els.input.focus();
                            return;
                        }
                        finish(value);
                    }
                }
            ]);
            setTimeout(() => els.input.focus(), 80);
        }

        openUiDialog();
    }));
}

function uiAlert(message, options = {}) {
    const variant = options.variant || inferDialogVariant(message, 'info');
    return showUiDialog({
        type: 'alert',
        message,
        title: options.title || (variant === 'error' ? 'Terjadi Kesalahan' : variant === 'success' ? 'Berhasil' : variant === 'warning' ? 'Perhatian' : 'Informasi'),
        variant,
        confirmText: options.confirmText || 'OK',
        dismissible: options.dismissible !== false,
        fallbackValue: true
    });
}

function uiConfirm(message, options = {}) {
    const variant = options.variant || inferDialogVariant(message, 'question');
    const danger = options.danger ?? /hapus|reset|restore|backup|tidak dapat dibatalkan|PERINGATAN|menghapus/i.test(String(message));
    return showUiDialog({
        type: 'confirm',
        message,
        title: options.title || (danger ? 'Konfirmasi Tindakan' : 'Konfirmasi'),
        variant: danger ? 'warning' : variant,
        danger,
        confirmText: options.confirmText || (danger ? 'Ya, Lanjutkan' : 'Ya'),
        cancelText: options.cancelText || 'Batal',
        dismissible: options.dismissible !== false,
        fallbackValue: false
    });
}

function uiPrompt(message, options = {}) {
    return showUiDialog({
        type: 'prompt',
        message,
        title: options.title || 'Masukkan Data',
        variant: options.variant || 'warning',
        defaultValue: options.defaultValue || '',
        placeholder: options.placeholder || '',
        inputHint: options.inputHint || '',
        matchValue: options.matchValue,
        matchError: options.matchError,
        confirmText: options.confirmText || 'Konfirmasi',
        cancelText: options.cancelText || 'Batal',
        dismissible: options.dismissible !== false,
        fallbackValue: null
    });
}

window.uiAlert = uiAlert;
window.uiConfirm = uiConfirm;
window.uiPrompt = uiPrompt;
