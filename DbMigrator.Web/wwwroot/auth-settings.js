let authSettingsLoaded = false;

async function refreshGlobalAuthUi() {
    const logoutButton = document.getElementById('global-logout-button');
    if (!logoutButton) return;
    try {
        const response = await fetch('/api/auth/status', { cache: 'no-store' });
        const result = await response.json();
        logoutButton.hidden = !result.LoginEnabled || !result.IsAuthenticated;
    } catch {
        logoutButton.hidden = true;
    }
}

async function loadAuthSettings(force = false) {
    if (authSettingsLoaded && !force) return;
    const status = document.getElementById('auth-settings-status');
    try {
        const response = await fetch('/api/auth/settings', { cache: 'no-store' });
        if (response.status === 401) {
            location.href = '/login.html';
            return;
        }
        const result = await response.json();
        if (!response.ok || !result.Success) throw new Error(result.Message || 'Gagal memuat pengaturan login.');
        document.getElementById('auth-login-enabled').checked = Boolean(result.LoginEnabled);
        document.getElementById('auth-username').value = result.Username || '';
        document.getElementById('auth-password').value = '';
        updateAuthModePreview();
        document.getElementById('global-logout-button').hidden = !result.LoginEnabled;
        authSettingsLoaded = true;
        if (status) status.textContent = '';
    } catch (error) {
        if (status) {
            status.className = 'settings-inline-status error';
            status.textContent = error.message;
        }
    }
}

function updateAuthModePreview() {
    const enabled = document.getElementById('auth-login-enabled')?.checked;
    const description = document.getElementById('auth-mode-description');
    if (description) {
        description.textContent = enabled
            ? 'Username dan password diperlukan sebelum aplikasi dapat dibuka.'
            : 'Mode bypass aktif: aplikasi dapat dibuka tanpa login.';
    }
}

function toggleAuthPassword() {
    const input = document.getElementById('auth-password');
    const icon = input?.parentElement?.querySelector('button i');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    if (icon) icon.className = input.type === 'password' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
}

async function saveAuthSettings(event) {
    event.preventDefault();
    const saveButton = document.getElementById('auth-settings-save');
    const status = document.getElementById('auth-settings-status');
    const payload = {
        LoginEnabled: document.getElementById('auth-login-enabled').checked,
        Username: document.getElementById('auth-username').value.trim(),
        Password: document.getElementById('auth-password').value || null
    };

    saveButton.disabled = true;
    status.className = 'settings-inline-status';
    status.textContent = 'Menyimpan perubahan...';
    try {
        const response = await fetch('/api/auth/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || !result.Success) throw new Error(result.Message || 'Gagal menyimpan pengaturan.');
        document.getElementById('auth-password').value = '';
        status.className = 'settings-inline-status success';
        status.textContent = result.Message;
        document.getElementById('global-logout-button').hidden = !result.LoginEnabled;
        await uiAlert(result.Message, { title: 'Pengaturan Tersimpan', variant: 'success' });
    } catch (error) {
        status.className = 'settings-inline-status error';
        status.textContent = error.message;
    } finally {
        saveButton.disabled = false;
    }
}

async function logoutApplication() {
    const confirmed = await uiConfirm('Keluar dari sesi aplikasi sekarang?', { title: 'Logout', variant: 'question' });
    if (!confirmed) return;
    await fetch('/api/auth/logout', { method: 'POST' });
    location.replace('/login.html');
}

document.addEventListener('DOMContentLoaded', refreshGlobalAuthUi);

window.refreshGlobalAuthUi = refreshGlobalAuthUi;
window.loadAuthSettings = loadAuthSettings;
window.updateAuthModePreview = updateAuthModePreview;
window.toggleAuthPassword = toggleAuthPassword;
window.saveAuthSettings = saveAuthSettings;
window.logoutApplication = logoutApplication;
