/* ============================================================================
   SSRS EXPLORER CLIENT MODULE
   ============================================================================ */

let ssrsConnection = null; // Stores { Url, Username, Password, Domain }
let currentSsrsPath = '/';
let ssrsItemsCache = [];

// Handle Switch Tab lifecycle hook
window.addEventListener('DOMContentLoaded', () => {
    // If the tab is stored as ssrs, make sure we initialize it
    const activeTab = localStorage.getItem('dbmigrator_active_tab');
    if (activeTab === 'ssrs') {
        initSsrsTab();
    }
});

// Intercept tab changes to trigger initialization when ssrs is opened
const originalSwitchMainTab = window.switchMainTab;
window.switchMainTab = function(tabId) {
    originalSwitchMainTab(tabId);
    if (tabId === 'ssrs') {
        initSsrsTab();
    }
};

let savedSsrsConnectionsCache = [];

function initSsrsTab() {
    if (ssrsConnection) {
        // Already connected, load current path
        browseSsrs(currentSsrsPath);
    } else {
        // Show login panel, hide explorer
        document.getElementById('ssrs-connect-panel').style.display = 'block';
        document.getElementById('ssrs-explorer-panel').style.display = 'none';
        loadSavedSsrsConnections();
    }
}

async function connectSsrs() {
    const url = document.getElementById('ssrs-url').value.trim();
    const username = document.getElementById('ssrs-username').value.trim();
    const password = document.getElementById('ssrs-password').value;
    const domain = document.getElementById('ssrs-domain').value.trim();

    if (!url || !username || !password) {
        await uiAlert("Mohon isi URL, Username, dan Password.", { variant: 'warning' });
        return;
    }

    const btn = document.getElementById('ssrs-btn-connect');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Menghubungkan...`;
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/ssrs/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Url: url, Username: username, Password: password, Domain: domain })
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data = await res.json();
        if (data.Success || data.success) {
            ssrsConnection = { Url: url, Username: username, Password: password, Domain: domain };
            currentSsrsPath = '/';

            // Save connection to history if checked
            const saveCheck = document.getElementById('ssrs-save-connection');
            const connNameInput = document.getElementById('ssrs-conn-name');
            if (saveCheck && saveCheck.checked && connNameInput && connNameInput.value.trim()) {
                try {
                    const saveRes = await fetch(`${API_BASE}/ssrs/connections`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ConnectionName: connNameInput.value.trim(),
                            Url: url,
                            Username: username,
                            Password: password,
                            Domain: domain
                        })
                    });
                    if (saveRes.ok) {
                        await loadSavedSsrsConnections();
                        saveCheck.checked = false;
                        connNameInput.value = '';
                        toggleSsrsSaveConnectionNameField();
                    }
                } catch (saveErr) {
                    console.error("Gagal menyimpan koneksi ke history:", saveErr);
                }
            }
            
            // Switch panels
            document.getElementById('ssrs-connect-panel').style.display = 'none';
            document.getElementById('ssrs-explorer-panel').style.display = 'flex';
            
            await browseSsrs('/');
        } else {
            await uiAlert("Koneksi gagal: " + (data.Message || "Pastikan kredensial dan URL sudah benar."), { variant: 'error' });
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Kesalahan koneksi: " + err.message, { variant: 'error' });
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function browseSsrs(path) {
    if (!ssrsConnection) return;

    currentSsrsPath = path;
    const loadingOverlay = document.getElementById('ssrs-loading-overlay');
    if (loadingOverlay) loadingOverlay.style.display = 'flex';

    try {
        const res = await fetch(`${API_BASE}/ssrs/browse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Url: ssrsConnection.Url,
                Username: ssrsConnection.Username,
                Password: ssrsConnection.Password,
                Domain: ssrsConnection.Domain,
                Path: path
            })
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data = await res.json();
        if (data.Success || data.success) {
            ssrsItemsCache = data.Items || data.items || [];
            renderSsrsBreadcrumbs(path);
            renderSsrsItems(ssrsItemsCache);
        } else {
            await uiAlert("Gagal memuat direktori: " + (data.Message || "Kesalahan tidak diketahui"), { variant: 'error' });
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal memuat folder: " + err.message, { variant: 'error' });
    } finally {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
}

function renderSsrsBreadcrumbs(path) {
    const container = document.getElementById('ssrs-breadcrumbs');
    if (!container) return;

    // Clear
    container.innerHTML = '';

    // Root node
    const rootItem = document.createElement('span');
    rootItem.className = 'ssrs-breadcrumb-link';
    rootItem.innerHTML = `<i class="fa-solid fa-house"></i> Home`;
    rootItem.onclick = () => browseSsrs('/');
    container.appendChild(rootItem);

    if (path === '/' || !path) {
        return;
    }

    const segments = path.split('/').filter(s => s);
    let cumulativePath = '';

    segments.forEach((seg, index) => {
        // Separator
        const sep = document.createElement('span');
        sep.className = 'ssrs-breadcrumb-separator';
        sep.innerHTML = `<i class="fa-solid fa-chevron-right" style="font-size: 0.7rem; color: var(--text-dark);"></i>`;
        container.appendChild(sep);

        cumulativePath += '/' + seg;

        const link = document.createElement('span');
        link.className = 'ssrs-breadcrumb-link';
        link.textContent = seg;
        
        // If last segment, make it active/non-clickable
        if (index === segments.length - 1) {
            link.classList.add('active');
        } else {
            const currentPathCopy = cumulativePath;
            link.onclick = () => browseSsrs(currentPathCopy);
        }
        container.appendChild(link);
    });
}

function renderSsrsItems(items) {
    const container = document.getElementById('ssrs-grid-container');
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem; color: var(--text-muted);">
                <i class="fa-regular fa-folder-open" style="font-size: 3rem; margin-bottom: 1rem; color: var(--text-dark);"></i>
                <p style="font-size: 0.95rem;">Folder ini kosong atau tidak memiliki berkas laporan.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = items.map(item => {
        const isFolder = item.TypeName === 'Folder' || item.typeName === 'Folder';
        const itemPath = item.Path || item.path;
        const itemName = item.Name || item.name;
        const type = item.TypeName || item.typeName;

        if (isFolder) {
            return `
                <div class="ssrs-card folder-card" onclick="browseSsrs('${itemPath.replace(/'/g, "\\'")}')">
                    <div class="ssrs-card-icon">
                        <i class="fa-solid fa-folder"></i>
                    </div>
                    <div class="ssrs-card-content">
                        <span class="ssrs-card-title" title="${itemName}">${itemName}</span>
                        <span class="ssrs-card-subtitle">Folder</span>
                    </div>
                    <div class="ssrs-card-actions">
                        <button class="btn-icon" onclick="downloadSsrsFolder(event, '${itemPath.replace(/'/g, "\\'")}')" title="Unduh Folder (ZIP)" style="color: var(--accent-indigo);">
                            <i class="fa-solid fa-file-zipper"></i>
                        </button>
                    </div>
                </div>
            `;
        } else {
            // It's a file (.rdl, .rsd, .rds)
            let iconClass = 'fa-file-code';
            let colorVar = 'var(--accent-teal)';
            if (type === 'DataSet') {
                iconClass = 'fa-database';
                colorVar = '#34d399';
            } else if (type === 'DataSource') {
                iconClass = 'fa-network-wired';
                colorVar = '#fb923c';
            }

            return `
                <div class="ssrs-card file-card">
                    <div class="ssrs-card-icon" style="color: ${colorVar};">
                        <i class="fa-solid ${iconClass}"></i>
                    </div>
                    <div class="ssrs-card-content">
                        <span class="ssrs-card-title" title="${itemName}">${itemName}</span>
                        <span class="ssrs-card-subtitle">${type}</span>
                    </div>
                    <div class="ssrs-card-actions">
                        <button class="btn-icon" onclick="downloadSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')" title="Unduh Definisi" style="color: var(--accent-teal);">
                            <i class="fa-solid fa-download"></i>
                        </button>
                    </div>
                </div>
            `;
        }
    }).join('');
}

function filterSsrsGrid() {
    const val = document.getElementById('ssrs-search-input').value.toLowerCase().trim();
    if (!val) {
        renderSsrsItems(ssrsItemsCache);
        return;
    }
    const filtered = ssrsItemsCache.filter(item => {
        const name = (item.Name || item.name || '').toLowerCase();
        return name.includes(val);
    });
    renderSsrsItems(filtered);
}

async function downloadSsrsItem(event, path, typeName) {
    if (event) event.stopPropagation();
    if (!ssrsConnection) return;

    const filename = path.split('/').pop() || 'report';
    await downloadFileFromApi(
        `${API_BASE}/ssrs/download`,
        {
            Url: ssrsConnection.Url,
            Username: ssrsConnection.Username,
            Password: ssrsConnection.Password,
            Domain: ssrsConnection.Domain,
            Path: path,
            TypeName: typeName
        },
        filename
    );
}

async function downloadSsrsFolder(event, path) {
    if (event) event.stopPropagation();
    if (!ssrsConnection) return;

    const loadingOverlay = document.getElementById('ssrs-loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.querySelector('span').textContent = 'Mengompresi dan menyiapkan unduhan ZIP...';
        loadingOverlay.style.display = 'flex';
    }

    const folderName = path.trim('/').split('/').pop() || 'Root';
    await downloadFileFromApi(
        `${API_BASE}/ssrs/download-folder`,
        {
            Url: ssrsConnection.Url,
            Username: ssrsConnection.Username,
            Password: ssrsConnection.Password,
            Domain: ssrsConnection.Domain,
            Path: path
        },
        `${folderName}_SSRS_Backup.zip`
    );

    if (loadingOverlay) {
        loadingOverlay.querySelector('span').textContent = 'Mengambil data dari server...';
        loadingOverlay.style.display = 'none';
    }
}

async function downloadCurrentFolderZip() {
    await downloadSsrsFolder(null, currentSsrsPath);
}

function disconnectSsrs() {
    ssrsConnection = null;
    currentSsrsPath = '/';
    ssrsItemsCache = [];
    document.getElementById('ssrs-connect-panel').style.display = 'block';
    document.getElementById('ssrs-explorer-panel').style.display = 'none';
}

async function downloadFileFromApi(endpoint, bodyData, defaultFilename) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (!response.ok) {
            throw new Error(await response.text());
        }
        
        let filename = defaultFilename;
        const disposition = response.headers.get('Content-Disposition');
        if (disposition && disposition.indexOf('attachment') !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches != null && matches[1]) { 
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal mengunduh berkas: " + err.message, { variant: 'error' });
    }
}

async function loadSavedSsrsConnections() {
    try {
        const res = await fetch(`${API_BASE}/ssrs/connections`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        savedSsrsConnectionsCache = data || [];
        
        const select = document.getElementById('ssrs-saved-select');
        if (select) {
            select.innerHTML = '<option value="">-- Pilih koneksi atau simpan baru --</option>' +
                savedSsrsConnectionsCache.map(conn => `<option value="${conn.Id || conn.id}">${escapeHtml(conn.ConnectionName || conn.connectionName)}</option>`).join('');
        }
    } catch (err) {
        console.error("Gagal memuat history koneksi SSRS:", err);
    }
}

function loadSavedSsrsConnection() {
    const select = document.getElementById('ssrs-saved-select');
    if (!select) return;
    const val = select.value;
    if (!val) {
        // Clear fields
        document.getElementById('ssrs-conn-name').value = '';
        document.getElementById('ssrs-url').value = '';
        document.getElementById('ssrs-username').value = '';
        document.getElementById('ssrs-password').value = '';
        document.getElementById('ssrs-domain').value = '';
        return;
    }

    const conn = savedSsrsConnectionsCache.find(c => (c.Id || c.id) == val);
    if (conn) {
        document.getElementById('ssrs-conn-name').value = conn.ConnectionName || conn.connectionName || '';
        document.getElementById('ssrs-url').value = conn.Url || conn.url || '';
        document.getElementById('ssrs-username').value = conn.Username || conn.username || '';
        document.getElementById('ssrs-password').value = conn.Password || conn.password || '';
        document.getElementById('ssrs-domain').value = conn.Domain || conn.domain || '';
    }
}

function toggleSsrsSaveConnectionNameField() {
    const checkbox = document.getElementById('ssrs-save-connection');
    const container = document.getElementById('ssrs-save-conn-name-container');
    if (checkbox && container) {
        container.style.display = checkbox.checked ? 'block' : 'none';
        if (checkbox.checked) {
            const connNameInput = document.getElementById('ssrs-conn-name');
            if (connNameInput) {
                const url = document.getElementById('ssrs-url').value.trim();
                let nameHint = "";
                try {
                    const parsedUrl = new URL(url);
                    nameHint = parsedUrl.host;
                } catch {
                    nameHint = url.replace("http://", "").replace("https://", "").split("/")[0];
                }
                connNameInput.value = nameHint ? `SSRS ${nameHint}` : '';
                connNameInput.focus();
            }
        }
    }
}

async function deleteSavedSsrsConnection() {
    const select = document.getElementById('ssrs-saved-select');
    if (!select) return;
    const val = select.value;
    if (!val) {
        await uiAlert("Silakan pilih koneksi dari history untuk dihapus.", { variant: 'warning' });
        return;
    }

    if (!(await uiConfirm("Hapus koneksi terpilih dari history?"))) return;

    try {
        const res = await fetch(`${API_BASE}/ssrs/connections/${val}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        if (data.Success || data.success) {
            await uiAlert("Koneksi berhasil dihapus dari history.");
            
            // Clear fields
            document.getElementById('ssrs-conn-name').value = '';
            document.getElementById('ssrs-url').value = '';
            document.getElementById('ssrs-username').value = '';
            document.getElementById('ssrs-password').value = '';
            document.getElementById('ssrs-domain').value = '';
            
            await loadSavedSsrsConnections();
        } else {
            await uiAlert("Gagal menghapus history: " + (data.Message || "Kesalahan tidak diketahui"), { variant: 'error' });
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Kesalahan saat menghapus history: " + err.message, { variant: 'error' });
    }
}
