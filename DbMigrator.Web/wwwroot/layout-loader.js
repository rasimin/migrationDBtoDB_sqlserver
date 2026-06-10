/* ============================================================================
   LAYOUT LOADER — injects HTML partials before app.js initializes
   ============================================================================ */

const SCREEN_PARTIALS = [
    'partials/screens/migration.html',
    'partials/screens/query.html',
    'partials/screens/beautifier.html',
    'partials/screens/whiteboard.html'
];

const MODAL_PARTIALS = [
    'partials/modals/migration-modals.html',
    'partials/modals/query-modals.html',
    'partials/modals/whiteboard-modals.html'
];

async function fetchPartial(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`Gagal memuat ${url} (HTTP ${response.status})`);
    }
    return response.text();
}

async function appendPartial(url, containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        throw new Error(`Container #${containerId} tidak ditemukan`);
    }
    const html = await fetchPartial(url);
    container.insertAdjacentHTML('beforeend', html);
}

function showLoaderError(message) {
    const loader = document.getElementById('app-loading');
    if (!loader) return;
    loader.classList.add('is-error');
    loader.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>${message}</p>
        <button type="button" class="btn btn-secondary" onclick="location.reload()">Muat Ulang</button>
    `;
}

window.__partialsReady = (async function loadAppPartials() {
    try {
        for (const url of SCREEN_PARTIALS) {
            await appendPartial(url, 'app-screens-root');
        }
        await Promise.all(MODAL_PARTIALS.map(url => appendPartial(url, 'app-modals-root')));
    } catch (err) {
        console.error('[layout-loader]', err);
        showLoaderError(err.message || 'Terjadi kesalahan saat memuat antarmuka.');
        throw err;
    } finally {
        const loader = document.getElementById('app-loading');
        if (loader) loader.remove();
    }
})();
