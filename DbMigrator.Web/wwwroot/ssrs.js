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
            
            const showCredsBtn = document.getElementById('ssrs-credentials-show-btn');
            if (showCredsBtn) showCredsBtn.style.display = 'inline-flex';
            
            const connInfoEl = document.getElementById('ssrs-active-conn-info');
            if (connInfoEl) {
                const cleanUrl = getSsrsBaseReportUrl(url).replace("http://", "").replace("https://", "");
                connInfoEl.textContent = domain ? `${domain}\\${username} @ ${cleanUrl}` : `${username} @ ${cleanUrl}`;
            }
            
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
    const backBtn = document.getElementById('ssrs-btn-back');
    if (backBtn) {
        if (path === '/' || !path) {
            backBtn.style.opacity = '0.3';
            backBtn.style.pointerEvents = 'none';
            backBtn.style.cursor = 'default';
        } else {
            backBtn.style.opacity = '1';
            backBtn.style.pointerEvents = 'auto';
            backBtn.style.cursor = 'pointer';
        }
    }

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
                        <div class="ssrs-dropdown">
                            <button class="btn-icon ssrs-dropdown-btn" onclick="toggleSsrsDropdown(event, this)" title="Pilihan">
                                <i class="fa-solid fa-ellipsis-vertical"></i>
                            </button>
                            <div class="ssrs-dropdown-content">
                                <button class="ssrs-dropdown-item" onclick="downloadSsrsFolder(event, '${itemPath.replace(/'/g, "\\'")}')">
                                    <i class="fa-solid fa-file-zipper" style="color: var(--accent-indigo);"></i> Unduh ZIP
                                </button>
                                <button class="ssrs-dropdown-item danger" onclick="deleteSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${itemName.replace(/'/g, "\\'")}')">
                                    <i class="fa-solid fa-trash-can"></i> Hapus Folder
                                </button>
                            </div>
                        </div>
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

            if (type === 'Report' || type === 'report') {
                return `
                    <div class="ssrs-card file-card" onclick="openSsrsReportDirectly(event, '${itemPath.replace(/'/g, "\\'")}')" style="cursor: pointer;">
                        <div class="ssrs-card-icon" style="color: ${colorVar};">
                            <i class="fa-solid ${iconClass}"></i>
                        </div>
                        <div class="ssrs-card-content">
                            <span class="ssrs-card-title" title="${itemName}">${itemName}</span>
                            <span class="ssrs-card-subtitle">${type}</span>
                        </div>
                        <div class="ssrs-card-actions">
                            <div class="ssrs-dropdown">
                                <button class="btn-icon ssrs-dropdown-btn" onclick="toggleSsrsDropdown(event, this)" title="Pilihan">
                                    <i class="fa-solid fa-ellipsis-vertical"></i>
                                </button>
                                <div class="ssrs-dropdown-content">
                                    <button class="ssrs-dropdown-item" onclick="openSsrsReportDirectly(event, '${itemPath.replace(/'/g, "\\'")}')">
                                        <i class="fa-solid fa-share-from-square" style="color: var(--accent-teal);"></i> Buka Laporan
                                    </button>
                                    <button class="ssrs-dropdown-item" onclick="viewSsrsReportDefinition(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')">
                                        <i class="fa-solid fa-code" style="color: var(--accent-indigo);"></i> Lihat Source XML
                                    </button>
                                    <button class="ssrs-dropdown-item" onclick="downloadSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')">
                                        <i class="fa-solid fa-download" style="color: var(--accent-teal);"></i> Unduh Definisi
                                    </button>
                                    <button class="ssrs-dropdown-item danger" onclick="deleteSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${itemName.replace(/'/g, "\\'")}')">
                                        <i class="fa-solid fa-trash-can"></i> Hapus Berkas
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                const clickAction = type === 'DataSource'
                    ? `openSsrsDataSourceModal(event, '${itemPath.replace(/'/g, "\\'")}', '${itemName.replace(/'/g, "\\'")}')`
                    : `viewSsrsReportDefinition(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')`;

                const editOrViewOption = type === 'DataSource'
                    ? `<button class="ssrs-dropdown-item" onclick="openSsrsDataSourceModal(event, '${itemPath.replace(/'/g, "\\'")}', '${itemName.replace(/'/g, "\\'")}')">
                           <i class="fa-solid fa-pen-to-square" style="color: #fb923c;"></i> Edit Data Source
                       </button>`
                    : `<button class="ssrs-dropdown-item" onclick="viewSsrsReportDefinition(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')">
                           <i class="fa-solid fa-code" style="color: var(--accent-indigo);"></i> Lihat Source XML
                       </button>`;

                return `
                    <div class="ssrs-card file-card" onclick="${clickAction}" style="cursor: pointer;">
                        <div class="ssrs-card-icon" style="color: ${colorVar};">
                            <i class="fa-solid ${iconClass}"></i>
                        </div>
                        <div class="ssrs-card-content">
                            <span class="ssrs-card-title" title="${itemName}">${itemName}</span>
                            <span class="ssrs-card-subtitle">${type}</span>
                        </div>
                        <div class="ssrs-card-actions">
                            <div class="ssrs-dropdown">
                                <button class="btn-icon ssrs-dropdown-btn" onclick="toggleSsrsDropdown(event, this)" title="Pilihan">
                                    <i class="fa-solid fa-ellipsis-vertical"></i>
                                </button>
                                <div class="ssrs-dropdown-content">
                                    ${editOrViewOption}
                                    <button class="ssrs-dropdown-item" onclick="downloadSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${type}')">
                                        <i class="fa-solid fa-download" style="color: var(--accent-teal);"></i> Unduh Definisi
                                    </button>
                                    <button class="ssrs-dropdown-item danger" onclick="deleteSsrsItem(event, '${itemPath.replace(/'/g, "\\'")}', '${itemName.replace(/'/g, "\\'")}')">
                                        <i class="fa-solid fa-trash-can"></i> Hapus Berkas
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
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
    
    const showCredsBtn = document.getElementById('ssrs-credentials-show-btn');
    if (showCredsBtn) showCredsBtn.style.display = 'none';
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

/* ============================================================================
   SSRS DEFINITION VIEWER POPUP CONTROLLERS (Monaco Editor & Iframe Preview)
   ============================================================================ */

let ssrsViewerEditor = null;
let ssrsViewerActiveCode = "";
let ssrsViewerActivePath = "";
let ssrsViewerActiveType = "";

function getSsrsBaseReportUrl(url) {
    let base = url.trim();
    base = base.replace(/\/+$/, "");
    if (base.toLowerCase().endsWith("/reportservice2010.asmx")) {
        base = base.substring(0, base.length - "/reportservice2010.asmx".length);
    }
    return base;
}

function getSsrsReportViewerUrl(url, path) {
    const baseUrl = getSsrsBaseReportUrl(url);
    const reportPath = encodeURIComponent(path);
    return `${baseUrl}/Pages/ReportViewer.aspx?${reportPath}&rs:Command=Render`;
}

function openSsrsReportDirectly(event, path) {
    if (event && event.stopPropagation) {
        event.stopPropagation();
    }
    if (!ssrsConnection) return;
    const renderUrl = getSsrsReportViewerUrl(ssrsConnection.Url, path);
    window.open(renderUrl, '_blank');
}

async function viewSsrsReportDefinition(event, path, type) {
    if (event && event.stopPropagation) {
        event.stopPropagation();
    }
    ssrsViewerActivePath = path;
    ssrsViewerActiveType = type;
    ssrsViewerActiveCode = ""; // Reset code cache
    
    const modal = document.getElementById('ssrs-viewer-modal');
    if (!modal) return;
    modal.classList.add('active');
    
    const titleEl = document.getElementById('ssrs-viewer-title');
    const filename = path.split('/').pop() || 'report';
    if (titleEl) {
        titleEl.innerHTML = `<i class="fa-solid fa-code" style="color: var(--accent-indigo);"></i> Source XML: <span style="color: var(--accent-indigo);">${escapeHtml(filename)}</span>`;
    }
    
    // Load Monaco code definition
    initSsrsViewerEditor("<!-- Memuat definisi berkas... -->");
    try {
        const res = await fetch(`${API_BASE}/ssrs/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Url: ssrsConnection.Url,
                Username: ssrsConnection.Username,
                Password: ssrsConnection.Password,
                Domain: ssrsConnection.Domain,
                Path: ssrsViewerActivePath,
                TypeName: ssrsViewerActiveType
            })
        });
        
        if (!res.ok) throw new Error(await res.text());
        
        const codeText = await res.text();
        ssrsViewerActiveCode = codeText;
        initSsrsViewerEditor(codeText);
    } catch (err) {
        console.error(err);
        ssrsViewerActiveCode = `<!-- Gagal memuat definisi: ${err.message} -->`;
        initSsrsViewerEditor(ssrsViewerActiveCode);
    }
}

function initSsrsViewerEditor(codeText) {
    const container = document.getElementById('ssrs-viewer-monaco-container');
    if (!container) return;
    
    if (ssrsViewerEditor) {
        ssrsViewerEditor.setValue(codeText);
        return;
    }
    
    if (typeof require === 'undefined') {
        console.error("Monaco loader is not loaded yet.");
        return;
    }
    
    require.config({ paths: { vs: 'lib/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], function() {
        if (ssrsViewerEditor) return;
        ssrsViewerEditor = monaco.editor.create(container, {
            value: codeText,
            language: 'xml',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            readOnly: true,
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto'
            }
        });
    });
}

function closeSsrsViewerModal() {
    const modal = document.getElementById('ssrs-viewer-modal');
    if (modal) {
        modal.classList.remove('active');
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.classList.remove('maximized');
        }
        const icon = document.getElementById('ssrs-viewer-maximize-icon');
        if (icon) {
            icon.className = 'fa-solid fa-expand';
        }
    }
}

function toggleSsrsViewerMaximize() {
    const modal = document.getElementById('ssrs-viewer-modal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const icon = document.getElementById('ssrs-viewer-maximize-icon');
    
    if (content) {
        const isMaximized = content.classList.toggle('maximized');
        if (icon) {
            icon.className = isMaximized ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        }
    }
}

async function copySsrsToClipboard() {
    if (!ssrsViewerActiveCode) return;
    try {
        await navigator.clipboard.writeText(ssrsViewerActiveCode);
        await uiAlert("Definisi laporan berhasil disalin ke clipboard!");
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal menyalin: " + err.message, { variant: 'error' });
    }
}

async function downloadSsrsActiveItem() {
    if (!ssrsViewerActivePath) return;
    await downloadSsrsItem(null, ssrsViewerActivePath, ssrsViewerActiveType);
}

/* ============================================================================
   SSRS CREATE FOLDER CONTROLLERS
   ============================================================================ */

function openCreateSsrsFolderModal() {
    if (!ssrsConnection) return;
    const modal = document.getElementById('ssrs-create-folder-modal');
    if (!modal) return;
    
    document.getElementById('ssrs-new-folder-parent-path').value = currentSsrsPath;
    document.getElementById('ssrs-new-folder-name').value = '';
    
    modal.classList.add('active');
    setTimeout(() => {
        document.getElementById('ssrs-new-folder-name').focus();
    }, 100);
}

function closeCreateSsrsFolderModal() {
    const modal = document.getElementById('ssrs-create-folder-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function submitCreateSsrsFolder() {
    if (!ssrsConnection) return;
    
    const folderName = document.getElementById('ssrs-new-folder-name').value.trim();
    if (!folderName) {
        await uiAlert("Nama folder tidak boleh kosong.", { variant: 'warning' });
        return;
    }
    
    const parentPath = currentSsrsPath;
    const body = {
        Url: ssrsConnection.Url,
        Username: ssrsConnection.Username,
        Password: ssrsConnection.Password,
        Domain: ssrsConnection.Domain,
        ParentPath: parentPath,
        FolderName: folderName
    };
    
    const modal = document.getElementById('ssrs-create-folder-modal');
    const submitBtn = modal.querySelector('.modal-footer .btn-primary');
    const originalHtml = submitBtn.innerHTML;
    
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    submitBtn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/ssrs/create-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        if (!res.ok) {
            throw new Error(await res.text());
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(`Folder '${folderName}' berhasil dibuat.`);
            closeCreateSsrsFolderModal();
            // Refresh folder list
            await browseSsrs(currentSsrsPath);
        } else {
            throw new Error(data.Message || "Gagal membuat folder");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal membuat folder: " + err.message, { variant: 'error' });
    } finally {
        submitBtn.innerHTML = originalHtml;
        submitBtn.disabled = false;
    }
}

/* ============================================================================
   SSRS UPLOAD & DELETE CONTROLLERS
   ============================================================================ */

async function deleteSsrsItem(event, path, name) {
    if (event) event.stopPropagation();
    if (!ssrsConnection) return;
    
    if (!(await uiConfirm(`Apakah Anda yakin ingin menghapus "${name}"? Tindakan ini tidak dapat dibatalkan.`))) {
        return;
    }
    
    const loadingOverlay = document.getElementById('ssrs-loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.querySelector('span').textContent = 'Menghapus item dari server...';
        loadingOverlay.style.display = 'flex';
    }
    
    try {
        const res = await fetch(`${API_BASE}/ssrs/delete-item`, {
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
            await uiAlert(`"${name}" berhasil dihapus.`);
            await browseSsrs(currentSsrsPath);
        } else {
            throw new Error(data.Message || "Gagal menghapus item.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal menghapus item: " + err.message, { variant: 'error' });
    } finally {
        if (loadingOverlay) {
            loadingOverlay.querySelector('span').textContent = 'Mengambil data dari server...';
            loadingOverlay.style.display = 'none';
        }
    }
}

function triggerSsrsUpload() {
    const fileInput = document.getElementById('ssrs-file-upload-input');
    if (fileInput) fileInput.click();
}

async function handleSsrsFileSelected(event) {
    const fileInput = event.target;
    if (!fileInput || fileInput.files.length === 0) return;
    
    const file = fileInput.files[0];
    if (!ssrsConnection) return;
    
    const loadingOverlay = document.getElementById('ssrs-loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.querySelector('span').textContent = `Mengunggah berkas "${file.name}"...`;
        loadingOverlay.style.display = 'flex';
    }
    
    const formData = new FormData();
    formData.append("url", ssrsConnection.Url);
    formData.append("username", ssrsConnection.Username);
    formData.append("password", ssrsConnection.Password);
    formData.append("domain", ssrsConnection.Domain);
    formData.append("parentPath", currentSsrsPath);
    formData.append("file", file);
    
    try {
        const res = await fetch(`${API_BASE}/ssrs/upload`, {
            method: 'POST',
            body: formData
        });
        
        if (!res.ok) {
            throw new Error(await res.text());
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Berkas berhasil diunggah.");
            await browseSsrs(currentSsrsPath);
        } else {
            throw new Error(data.Message || "Gagal mengunggah berkas.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal mengunggah: " + err.message, { variant: 'error' });
    } finally {
        // Reset file input so same file can be selected again
        fileInput.value = '';
        
        if (loadingOverlay) {
            loadingOverlay.querySelector('span').textContent = 'Mengambil data dari server...';
            loadingOverlay.style.display = 'none';
        }
    }
}

/* ============================================================================
   SSRS EDIT DATASOURCE CONTROLLERS [NEW]
   ============================================================================ */

function toggleSsrsDsCredentialsFields() {
    const credSelect = document.getElementById('ssrs-ds-credretrieval');
    const storeFields = document.getElementById('ssrs-ds-store-fields');
    if (credSelect && storeFields) {
        storeFields.style.display = credSelect.value === 'Store' ? 'flex' : 'none';
    }
}

function updateSsrsDsConnectionString() {
    const serverInput = document.getElementById('ssrs-ds-server');
    const databaseInput = document.getElementById('ssrs-ds-database');
    const connstringInput = document.getElementById('ssrs-ds-connstring');

    if (serverInput && databaseInput && connstringInput) {
        const server = serverInput.value.trim();
        const db = databaseInput.value.trim();
        
        // Build basic connection string
        if (server && db) {
            connstringInput.value = `data source=${server};initial catalog=${db}`;
        }
    }
}

function parseSsrsDsConnectionString(connString) {
    let server = '';
    let db = '';
    
    if (connString) {
        const parts = connString.split(';');
        parts.forEach(part => {
            if (!part) return;
            const kv = part.split('=');
            if (kv.length === 2) {
                const key = kv[0].trim().toLowerCase();
                const val = kv[1].trim();
                if (key === 'data source' || key === 'server' || key === 'addr' || key === 'address') {
                    server = val;
                } else if (key === 'initial catalog' || key === 'database' || key === 'db') {
                    db = val;
                }
            }
        });
    }
    return { server, db };
}

async function openSsrsDataSourceModal(event, path, name) {
    if (event && event.stopPropagation) {
        event.stopPropagation();
    }
    if (!ssrsConnection) return;
    
    const modal = document.getElementById('ssrs-datasource-modal');
    if (!modal) return;
    
    document.getElementById('ssrs-ds-modal-title').textContent = `Edit Shared Data Source: ${name}`;
    document.getElementById('ssrs-ds-path').value = path;
    
    // Reset fields to empty first
    document.getElementById('ssrs-ds-server').value = '';
    document.getElementById('ssrs-ds-database').value = '';
    document.getElementById('ssrs-ds-connstring').value = '';
    document.getElementById('ssrs-ds-credretrieval').value = 'Store';
    document.getElementById('ssrs-ds-username').value = '';
    document.getElementById('ssrs-ds-password').value = '';
    document.getElementById('ssrs-ds-wincreds').checked = false;
    
    toggleSsrsDsCredentialsFields();
    
    // Show modal loading or modal active first
    modal.classList.add('active');
    
    const originalSaveBtn = document.getElementById('ssrs-ds-btn-save');
    if (originalSaveBtn) originalSaveBtn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/ssrs/get-datasource`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Url: ssrsConnection.Url,
                Username: ssrsConnection.Username,
                Password: ssrsConnection.Password,
                Domain: ssrsConnection.Domain,
                Path: path,
                TypeName: 'DataSource'
            })
        });
        
        if (!res.ok) {
            throw new Error(await res.text());
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            document.getElementById('ssrs-ds-connstring').value = data.ConnectString || '';
            document.getElementById('ssrs-ds-credretrieval').value = data.CredentialRetrieval || 'Store';
            document.getElementById('ssrs-ds-wincreds').checked = !!data.WindowsCredentials;
            document.getElementById('ssrs-ds-username').value = data.UserName || '';
            
            // Try to parse server and db
            const parsed = parseSsrsDsConnectionString(data.ConnectString);
            document.getElementById('ssrs-ds-server').value = parsed.server;
            document.getElementById('ssrs-ds-database').value = parsed.db;
            
            toggleSsrsDsCredentialsFields();
        } else {
            throw new Error(data.Message || "Gagal mengambil properti Data Source");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal memuat properti Data Source: " + err.message, { variant: 'error' });
        closeSsrsDataSourceModal();
    } finally {
        if (originalSaveBtn) originalSaveBtn.disabled = false;
    }
}

function closeSsrsDataSourceModal() {
    const modal = document.getElementById('ssrs-datasource-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function testSsrsDsConnection() {
    const connString = document.getElementById('ssrs-ds-connstring').value.trim();
    const retrieval = document.getElementById('ssrs-ds-credretrieval').value;
    const username = document.getElementById('ssrs-ds-username').value.trim();
    const password = document.getElementById('ssrs-ds-password').value;
    const winCreds = document.getElementById('ssrs-ds-wincreds').checked;
    
    if (!connString) {
        await uiAlert("Mohon isi Server Name / Connection String terlebih dahulu.", { variant: 'warning' });
        return;
    }

    const testBtn = document.getElementById('ssrs-ds-btn-test');
    const originalText = testBtn.innerHTML;
    testBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Testing...`;
    testBtn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/ssrs/test-datasource-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ConnectString: connString,
                CredentialRetrieval: retrieval,
                WindowsCredentials: winCreds,
                UserName: username,
                Password: password
            })
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert("Koneksi berhasil terhubung!", { variant: 'success' });
        } else {
            await uiAlert("Koneksi gagal: " + (data.Message || "Kesalahan tidak diketahui"), { variant: 'error' });
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal menguji koneksi: " + err.message, { variant: 'error' });
    } finally {
        testBtn.innerHTML = originalText;
        testBtn.disabled = false;
    }
}

async function submitSsrsDataSourceChanges() {
    if (!ssrsConnection) return;
    
    const path = document.getElementById('ssrs-ds-path').value;
    const connString = document.getElementById('ssrs-ds-connstring').value.trim();
    const retrieval = document.getElementById('ssrs-ds-credretrieval').value;
    const username = document.getElementById('ssrs-ds-username').value.trim();
    const password = document.getElementById('ssrs-ds-password').value;
    const winCreds = document.getElementById('ssrs-ds-wincreds').checked;

    if (!connString) {
        await uiAlert("Connection String tidak boleh kosong.", { variant: 'warning' });
        return;
    }

    if (retrieval === 'Store' && !username) {
        await uiAlert("Mohon isi Username Database untuk jenis autentikasi Store.", { variant: 'warning' });
        return;
    }

    const saveBtn = document.getElementById('ssrs-ds-btn-save');
    const originalText = saveBtn.innerHTML;
    saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    saveBtn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/ssrs/set-datasource`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Url: ssrsConnection.Url,
                Username: ssrsConnection.Username,
                Password: ssrsConnection.Password,
                Domain: ssrsConnection.Domain,
                Path: path,
                Definition: {
                    Extension: "SQL",
                    ConnectString: connString,
                    CredentialRetrieval: retrieval,
                    WindowsCredentials: winCreds,
                    UserName: username,
                    Password: password
                }
            })
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert("Properti Data Source berhasil diperbarui.");
            closeSsrsDataSourceModal();
            // Refresh folder
            await browseSsrs(currentSsrsPath);
        } else {
            throw new Error(data.Message || "Gagal menyimpan perubahan");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal menyimpan perubahan Data Source: " + err.message, { variant: 'error' });
    } finally {
        saveBtn.innerHTML = originalText;
        saveBtn.disabled = false;
    }
}

/* ============================================================================
   SSRS CONNECTION CREDENTIALS POPUP CONTROLLERS
   ============================================================================ */

function showSsrsCredentialsPopup() {
    if (!ssrsConnection) return;
    
    const modal = document.getElementById('ssrs-credentials-modal');
    if (!modal) return;
    
    // Set fields
    document.getElementById('ssrs-show-url').value = ssrsConnection.Url || '';
    document.getElementById('ssrs-show-username').value = ssrsConnection.Username || '';
    
    // Reset password visibility
    const passwordInput = document.getElementById('ssrs-show-password');
    if (passwordInput) {
        passwordInput.value = ssrsConnection.Password || '';
        passwordInput.type = 'password';
    }
    const passIcon = document.getElementById('ssrs-show-pass-icon');
    if (passIcon) {
        passIcon.className = 'fa-solid fa-eye';
    }
    
    // Show/hide domain
    const domainInput = document.getElementById('ssrs-show-domain');
    const domainGroup = document.getElementById('ssrs-show-domain-group');
    if (domainInput && domainGroup) {
        if (ssrsConnection.Domain) {
            domainInput.value = ssrsConnection.Domain;
            domainGroup.style.display = 'block';
        } else {
            domainInput.value = '';
            domainGroup.style.display = 'none';
        }
    }
    
    modal.classList.add('active');
}

function closeSsrsCredentialsModal() {
    const modal = document.getElementById('ssrs-credentials-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

function toggleSsrsShowPasswordVisibility() {
    const input = document.getElementById('ssrs-show-password');
    const icon = document.getElementById('ssrs-show-pass-icon');
    if (input && icon) {
        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'fa-solid fa-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'fa-solid fa-eye';
        }
    }
}

async function copySsrsCredentialText(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    
    try {
        await navigator.clipboard.writeText(input.value);
        await uiAlert("Kredensial berhasil disalin ke clipboard!");
    } catch (err) {
        console.error("Gagal menyalin kredensial:", err);
        await uiAlert("Gagal menyalin: " + err.message, { variant: 'error' });
    }
}

function goUpSsrsFolder() {
    if (currentSsrsPath === '/' || !currentSsrsPath) return;
    
    const segments = currentSsrsPath.split('/').filter(s => s);
    if (segments.length <= 1) {
        browseSsrs('/');
    } else {
        segments.pop();
        browseSsrs('/' + segments.join('/'));
    }
}

/* ============================================================================
   SSRS EXPLORER CARD DROPDOWN CONTROLLERS
   ============================================================================ */
function toggleSsrsDropdown(event, element) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const dropdown = element.closest('.ssrs-dropdown');
    if (!dropdown) return;
    
    const card = element.closest('.ssrs-card');
    
    // Close all other dropdowns and remove dropdown-active class from other cards
    document.querySelectorAll('.ssrs-dropdown').forEach(dd => {
        if (dd !== dropdown) {
            dd.classList.remove('active');
            const c = dd.closest('.ssrs-card');
            if (c) c.classList.remove('dropdown-active');
        }
    });
    
    const isActive = dropdown.classList.toggle('active');
    if (card) {
        card.classList.toggle('dropdown-active', isActive);
    }
}

// Close dropdowns on clicking outside
window.addEventListener('click', (e) => {
    if (!e.target.closest('.ssrs-dropdown')) {
        document.querySelectorAll('.ssrs-dropdown').forEach(dd => {
            dd.classList.remove('active');
            const c = dd.closest('.ssrs-card');
            if (c) c.classList.remove('dropdown-active');
        });
    }
});

