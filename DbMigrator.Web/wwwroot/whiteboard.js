/* ============================================================================
   WHITEBOARD SYSTEM LOGIC (Excalidraw & Gallery) - whiteboard.js
   ============================================================================ */

function initWhiteboardTab() {
    const grid = document.getElementById('whiteboard-grid-container');
    if (!grid) return;
    
    // Reset inputs
    const searchInput = document.getElementById('whiteboard-search');
    if (searchInput) searchInput.value = '';
    
    // Hide workspace and show gallery
    document.getElementById('whiteboard-workspace-view').style.display = 'none';
    document.getElementById('whiteboard-gallery-view').style.display = 'block';
    
    loadWhiteboards();
}

async function loadWhiteboards() {
    try {
        const res = await fetch(`${API_BASE}/whiteboards`);
        if (!res.ok) return;
        whiteboardDrawingsCache = await res.json();
        
        // Populate tag filter
        populateWhiteboardTagFilter();
        
        filterWhiteboards();
    } catch (err) {
        console.error("Gagal mengambil daftar whiteboard: ", err);
    }
}

function populateWhiteboardTagFilter() {
    const select = document.getElementById('whiteboard-tag-filter');
    if (!select) return;
    
    const tags = new Set();
    whiteboardDrawingsCache.forEach(wb => {
        const tag = wb.TagName || wb.tagName;
        if (tag && tag.trim() !== '') {
            tags.add(tag.trim());
        }
    });
    
    select.innerHTML = '<option value="ALL">Semua Tag</option>';
    tags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        select.appendChild(opt);
    });
}

function filterWhiteboards() {
    const searchVal = (document.getElementById('whiteboard-search')?.value || '').trim().toLowerCase();
    const tagVal = document.getElementById('whiteboard-tag-filter')?.value || 'ALL';
    
    const filtered = whiteboardDrawingsCache.filter(wb => {
        const alias = (wb.AliasName || wb.aliasName || '').toLowerCase();
        const tag = (wb.TagName || wb.tagName || '').toLowerCase();
        const matchSearch = alias.includes(searchVal) || tag.includes(searchVal);
        const matchTag = (tagVal === 'ALL' || (wb.TagName || wb.tagName || '').trim() === tagVal);
        return matchSearch && matchTag;
    });
    
    renderWhiteboards(filtered);
}

function renderWhiteboards(drawings) {
    const container = document.getElementById('whiteboard-grid-container');
    if (!container) return;
    
    if (drawings.length === 0) {
        container.innerHTML = `
            <div class="whiteboard-empty-gallery">
                <i class="fa-solid fa-pen-ruler"></i>
                <h3>Belum Ada Sketsa</h3>
                <p>Klik tombol <strong>Create</strong> di kanan atas untuk membuat diagram sketsa alur data baru.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = drawings.map(wb => {
        const id = wb.Id || wb.id;
        const alias = wb.AliasName || wb.aliasName;
        const tag = wb.TagName || wb.tagName || '';
        const thumb = wb.ThumbnailData || wb.thumbnailData;
        
        const imgHtml = thumb 
            ? `<img src="${thumb}" alt="${alias}">` 
            : `<i class="fa-solid fa-file-signature whiteboard-placeholder-thumb"></i>`;
            
        const tagHtml = tag.trim() !== '' 
            ? `<span class="whiteboard-card-tag">${escapeHtml(tag)}</span>` 
            : `<span class="whiteboard-card-tag empty">No Tag</span>`;
            
        return `
            <div class="whiteboard-card">
                <!-- Thumbnail pratinjau -->
                <div class="whiteboard-thumbnail-wrapper" onclick="openWhiteboardWorkspace(${id})">
                    ${imgHtml}
                </div>
                <!-- Metadata sketsa -->
                <div class="whiteboard-card-info">
                    <h4 class="whiteboard-card-title">${escapeHtml(alias)}</h4>
                    <div class="whiteboard-card-meta">
                        ${tagHtml}
                        <span style="font-size: 0.68rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${new Date(wb.UpdatedAt || wb.updatedAt).toLocaleDateString()}</span>
                    </div>
                </div>
                <!-- Tombol aksi melayang -->
                <div class="whiteboard-card-actions">
                    <button onclick="openWhiteboardWorkspace(${id})" title="Edit Sketsa">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="delete" onclick="deleteWhiteboard(${id}, event)" title="Hapus Sketsa">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function openNewWhiteboardModal() {
    document.getElementById('whiteboard-new-name').value = '';
    document.getElementById('whiteboard-new-tag').value = '';
    document.getElementById('create-whiteboard-modal').classList.add('active');
}

function closeNewWhiteboardModal() {
    document.getElementById('create-whiteboard-modal').classList.remove('active');
}

async function createNewWhiteboardExec() {
    const aliasName = document.getElementById('whiteboard-new-name').value.trim();
    const tagName = document.getElementById('whiteboard-new-tag').value.trim();
    
    if (!aliasName) {
        await uiAlert("Nama sketsa (Alias Name) tidak boleh kosong!");
        return;
    }
    
    const payload = {
        AliasName: aliasName,
        TagName: tagName
    };
    
    try {
        const res = await fetch(`${API_BASE}/whiteboards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            const saved = await res.json();
            closeNewWhiteboardModal();
            
            // Reload list in background
            await loadWhiteboards();
            
            // Open excalidraw workspace immediately
            openWhiteboardWorkspace(saved.Id || saved.id);
        } else {
            const errText = await res.text();
            await uiAlert("Gagal membuat sketsa: " + errText);
        }
    } catch (err) {
        console.error("Gagal menyimpan sketsa baru: ", err);
        await uiAlert("Terjadi kesalahan: " + err.message);
    }
}

async function openWhiteboardWorkspace(id) {
    try {
        const res = await fetch(`${API_BASE}/whiteboards/${id}`);
        if (!res.ok) {
            await uiAlert("Gagal memuat detail sketsa.");
            return;
        }
        const wb = await res.json();
        activeWhiteboardId = id;
        
        document.getElementById('workspace-drawing-title').textContent = wb.AliasName || wb.aliasName;
        const tag = wb.TagName || wb.tagName || '';
        const tagEl = document.getElementById('workspace-drawing-tag');
        if (tagEl) {
            if (tag.trim() !== '') {
                tagEl.textContent = tag;
                tagEl.style.display = 'inline-block';
            } else {
                tagEl.style.display = 'none';
            }
        }
        
        // Toggle view
        document.getElementById('whiteboard-gallery-view').style.display = 'none';
        document.getElementById('whiteboard-workspace-view').style.display = 'block';
        
        // Mount Excalidraw Component
        const mountPoint = document.getElementById('excalidraw-mount-container');
        if (!excalidrawReactRoot) {
            excalidrawReactRoot = ReactDOM.createRoot(mountPoint);
        }
        
        let initialData = {};
        if (wb.WhiteboardData || wb.whiteboardData) {
            try {
                initialData = JSON.parse(wb.WhiteboardData || wb.whiteboardData);
            } catch (e) {
                console.error("Gagal parse whiteboard data JSON: ", e);
            }
        }
        
        // Render
        excalidrawReactRoot.render(
            React.createElement(ExcalidrawLib.Excalidraw, {
                excalidrawAPI: (api) => {
                    excalidrawReactRef = api;
                    if (api && initialData && initialData.elements) {
                        setTimeout(() => {
                            try {
                                // Hanya update elements untuk menghindari crash akibat deserialisasi appState (seperti collaborators Map)
                                api.updateScene({
                                    elements: initialData.elements
                                });
                            } catch (err) {
                                console.error("Gagal update scene Excalidraw: ", err);
                            }
                        }, 100);
                    }
                },
                theme: "dark"
            })
        );
    } catch (err) {
        console.error("Error open whiteboard workspace: ", err);
        await uiAlert("Terjadi kesalahan saat membuka sketsa: " + err.message);
    }
}

async function saveActiveWhiteboard() {
    if (!activeWhiteboardId || !excalidrawReactRef) return;
    
    const btn = document.getElementById('btn-save-whiteboard');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    btn.disabled = true;
    
    try {
        const elements = excalidrawReactRef.getSceneElements();
        const appState = excalidrawReactRef.getAppState();
        const sceneJson = JSON.stringify({ elements, appState });
        
        // Export PNG preview (base64)
        if (elements && elements.length > 0) {
            ExcalidrawLib.exportToBlob({
                elements: elements,
                appState: { 
                    ...appState, 
                    exportWithBackground: true,
                    theme: "dark",
                    viewBackgroundColor: "#121212"
                },
                mimeType: "image/png"
            }).then(blob => {
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = async function() {
                    const base64data = reader.result;
                    await executeSaveWhiteboard(activeWhiteboardId, sceneJson, base64data, btn, originalText);
                };
            }).catch(err => {
                console.error("Gagal mengekspor thumbnail: ", err);
                executeSaveWhiteboard(activeWhiteboardId, sceneJson, null, btn, originalText);
            });
        } else {
            await executeSaveWhiteboard(activeWhiteboardId, sceneJson, null, btn, originalText);
        }
    } catch (err) {
        console.error("Gagal menyimpan whiteboard: ", err);
        await uiAlert("Gagal menyimpan sketsa: " + err.message);
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function executeSaveWhiteboard(id, json, thumbnailBase64, btn, originalText) {
    try {
        const payload = {
            Id: id,
            WhiteboardData: json,
            ThumbnailData: thumbnailBase64
        };
        
        const res = await fetch(`${API_BASE}/whiteboards/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            await uiAlert("Sketsa berhasil disimpan!");
        } else {
            const errText = await res.text();
            await uiAlert("Gagal menyimpan sketsa: " + errText);
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error saving: " + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function closeWhiteboardWorkspace() {
    activeWhiteboardId = null;
    excalidrawReactRef = null;
    if (excalidrawReactRoot) {
        try {
            excalidrawReactRoot.unmount();
        } catch (e) {
            console.error("Error unmounting Excalidraw root:", e);
        }
        excalidrawReactRoot = null;
    }
    
    // Toggle view
    document.getElementById('whiteboard-workspace-view').style.display = 'none';
    document.getElementById('whiteboard-gallery-view').style.display = 'block';
    
    loadWhiteboards();
}

async function resetWorkspaceCanvas() {
    console.log("resetWorkspaceCanvas called");
    if (!excalidrawReactRef) {
        console.warn("excalidrawReactRef is null!");
        await uiAlert("Kanvas belum siap. Coba beberapa saat lagi.");
        return;
    }
    
    if (await uiConfirm("Apakah Anda yakin ingin mengosongkan kanvas sketsa saat ini? Tindakan ini tidak dapat dibatalkan!")) {
        try {
            console.log("Resetting canvas scene");
            excalidrawReactRef.updateScene({
                elements: []
            });
            console.log("Canvas scene reset successfully");
        } catch (e) {
            console.error("Gagal reset scene:", e);
            await uiAlert("Gagal mengosongkan kanvas: " + e.message);
        }
    }
}

async function deleteWhiteboard(id, event) {
    console.log("deleteWhiteboard called with id:", id);
    if (event) {
        console.log("Stopping event propagation");
        event.stopPropagation();
    }
    
    const confirmed = await uiConfirm("Apakah Anda yakin ingin menghapus sketsa coretan ini secara permanen?");
    console.log("Confirmation result:", confirmed);
    if (!confirmed) {
        return;
    }
    
    try {
        console.log("Sending DELETE request to:", `${API_BASE}/whiteboards/${id}`);
        const res = await fetch(`${API_BASE}/whiteboards/${id}`, {
            method: 'DELETE'
        });
        console.log("DELETE response status:", res.status);
        if (res.ok) {
            console.log("Deletion successful, reloading whiteboards");
            loadWhiteboards();
        } else {
            const errText = await res.text();
            console.error("Deletion failed on server:", errText);
            await uiAlert("Gagal menghapus sketsa: " + errText);
        }
    } catch (err) {
        console.error("Gagal menghapus: ", err);
        await uiAlert("Terjadi kesalahan saat menghapus: " + err.message);
    }
}
