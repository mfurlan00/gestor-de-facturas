// Gestor de Facturas Local - 100% en cliente
// Almacenamiento: IndexedDB con fallback a localStorage

(function () {
  'use strict';

  // ---------- Utilidades ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now();

  const toDate = (v) => v ? new Date(v) : null;
  const ymd = (d) => {
    if (!d) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const confirmDialog = (msg) => window.confirm(msg);

  // ---------- Configuración (IRPF, tema) ----------
  const settings = {
    get irpfPct() { return parseFloat(localStorage.getItem('irpfPct') ?? '15') || 0; },
    set irpfPct(v) { localStorage.setItem('irpfPct', String(v)); },
    get themeDark() { return localStorage.getItem('theme') === 'dark'; },
    set themeDark(v) { localStorage.setItem('theme', v ? 'dark' : 'light'); }
  };

  const applyTheme = () => {
    document.body.classList.toggle('dark', settings.themeDark);
    $('#toggle-theme').checked = settings.themeDark;
  };

  // ---------- IndexedDB wrapper con fallback ----------
  const DB_NAME = 'facturasDB';
  const STORE = 'invoices';
  let db = null; // IDBDatabase
  let useLocal = false;

  function idbOpen() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        useLocal = true;
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('number', 'number', { unique: true });
          store.createIndex('date', 'date');
          store.createIndex('type', 'type');
          store.createIndex('category', 'category');
          store.createIndex('archived', 'archived');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { useLocal = true; resolve(null); };
    });
  }

  function idbTx(mode) {
    return db.transaction([STORE], mode).objectStore(STORE);
  }

  async function dbGetAll() {
    if (useLocal) {
      const raw = localStorage.getItem('invoices') || '[]';
      return JSON.parse(raw);
    }
    return new Promise((resolve, reject) => {
      const store = idbTx('readonly');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAdd(inv) {
    if (useLocal) {
      const arr = await dbGetAll();
      arr.push(inv);
      localStorage.setItem('invoices', JSON.stringify(arr));
      return inv.id;
    }
    return new Promise((resolve, reject) => {
      const store = idbTx('readwrite');
      const req = store.add(inv);
      req.onsuccess = () => resolve(inv.id);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(inv) {
    if (useLocal) {
      const arr = await dbGetAll();
      const idx = arr.findIndex(x => x.id === inv.id);
      if (idx >= 0) arr[idx] = inv; else arr.push(inv);
      localStorage.setItem('invoices', JSON.stringify(arr));
      return inv.id;
    }
    return new Promise((resolve, reject) => {
      const store = idbTx('readwrite');
      const req = store.put(inv);
      req.onsuccess = () => resolve(inv.id);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(id) {
    if (useLocal) {
      const arr = await dbGetAll();
      const next = arr.filter(x => x.id !== id);
      localStorage.setItem('invoices', JSON.stringify(next));
      return;
    }
    return new Promise((resolve, reject) => {
      const store = idbTx('readwrite');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbClearAndImport(arr) {
    if (useLocal) {
      localStorage.setItem('invoices', JSON.stringify(arr));
      return;
    }
    await new Promise((resolve, reject) => {
      const store = idbTx('readwrite');
      const clearReq = store.clear();
      clearReq.onsuccess = () => resolve();
      clearReq.onerror = () => reject(clearReq.error);
    });
    for (const inv of arr) await dbAdd(inv);
  }

  // ---------- Estado y render ----------
  let invoices = [];
  let currentPdfObjectUrl = null;

  const getFilters = () => {
    return {
      type: $('#filter-type').value.trim(),
      cat: $('#filter-category').value.trim().toLowerCase(),
      from: $('#filter-from').value ? new Date($('#filter-from').value) : null,
      to: $('#filter-to').value ? new Date($('#filter-to').value) : null,
      includeArchived: $('#filter-archived').checked,
      search: $('#filter-search').value.trim().toLowerCase()
    };
  };

  function applyFilters(list) {
    const f = getFilters();
    return list.filter(inv => {
      if (f.type && inv.type !== f.type) return false;
      if (!f.includeArchived && inv.archived) return false;
      if (f.cat && !(inv.category || '').toLowerCase().includes(f.cat)) return false;
      if (f.from && new Date(inv.date) < f.from) return false;
      if (f.to && new Date(inv.date) > f.to) return false;
      if (f.search) {
        const blob = `${inv.number} ${inv.entity} ${inv.concept} ${inv.notes}`.toLowerCase();
        if (!blob.includes(f.search)) return false;
      }
      return true;
    }).sort((a,b) => new Date(b.date) - new Date(a.date));
  }

  function recalcTotals(list) {
    let totalEmit = 0, totalRec = 0, ivaEmit = 0, ivaRec = 0;
    let countEmit = 0, countRec = 0;
    for (const inv of list) {
      const base = Number(inv.base) || 0;
      const ivaPct = Number(inv.ivaPct) || 0;
      const iva = base * ivaPct / 100;
      const total = base + iva;
      if (inv.type === 'emitida') { totalEmit += total; ivaEmit += iva; countEmit++; }
      else { totalRec += total; ivaRec += iva; countRec++; }
    }
    const beneficio = totalEmit - totalRec;
    const irpf = Math.max(0, beneficio) * (settings.irpfPct / 100);
    return { totalEmit, totalRec, beneficio, ivaEmit, ivaRec, ivaSaldo: ivaEmit - ivaRec, countEmit, countRec, irpf };
  }

  function updateKPIs(list) {
    const k = recalcTotals(list);
    $('#kpi-total-emitidas').textContent = fmt.format(k.totalEmit);
    $('#kpi-total-recibidas').textContent = fmt.format(k.totalRec);
    $('#kpi-beneficio').textContent = fmt.format(k.beneficio);
    $('#kpi-iva-emitido').textContent = fmt.format(k.ivaEmit);
    $('#kpi-iva-soportado').textContent = fmt.format(k.ivaRec);
    $('#kpi-iva-saldo').textContent = fmt.format(k.ivaSaldo);
    $('#kpi-count-emitidas').textContent = String(k.countEmit);
    $('#kpi-count-recibidas').textContent = String(k.countRec);
  }

  function renderTable(list) {
    const tbody = $('#tbody-invoices');
    tbody.innerHTML = '';
    for (const inv of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(inv.number)}</td>
        <td>${escapeHtml(inv.date)}</td>
        <td>${inv.type === 'emitida' ? 'Emitida' : 'Recibida'}</td>
        <td>${escapeHtml(inv.entity || '')}</td>
        <td>${escapeHtml(inv.concept || '')}</td>
        <td class="num">${fmt.format(Number(inv.base || 0))}</td>
        <td class="num">${Number(inv.ivaPct || 0).toFixed(2)}</td>
        <td class="num">${fmt.format((Number(inv.base || 0) * Number(inv.ivaPct || 0) / 100))}</td>
        <td class="num">${fmt.format((Number(inv.base || 0) * (1 + Number(inv.ivaPct || 0)/100)))}</td>
        <td>${escapeHtml(inv.payment || '')}</td>
        <td>${escapeHtml(inv.category || '')}</td>
        <td>${inv.pdfPath ? `<a href="${encodeURI(inv.pdfPath)}" target="_blank" rel="noopener">Abrir</a>` : ''}</td>
        <td>${inv.archived ? '✔︎' : ''}</td>
        <td class="row gap">
          <button class="btn secondary" data-action="edit" data-id="${inv.id}">Editar</button>
          <button class="btn" data-action="archive" data-id="${inv.id}">${inv.archived ? 'Desarchivar' : 'Archivar'}</button>
          <button class="btn danger" data-action="delete" data-id="${inv.id}">Eliminar</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
    $('#list-counter').textContent = `${list.length} elemento${list.length !== 1 ? 's' : ''}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]+/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  // ---------- Mini Charts (Canvas) ----------
  function drawBarChart(canvas, { labels, series, colors, title }) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);
    const padding = 28, axis = 24, top = 20;
    const chartW = W - padding*2 - 10;
    const chartH = H - top - axis - padding;
    const maxVal = Math.max(1, ...series.flat());
    const n = labels.length;
    const sCount = series.length;
    const groupW = chartW / Math.max(1, n);
    const barW = Math.max(4, (groupW - 8) / Math.max(1, sCount));
    // Axes
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, top);
    ctx.lineTo(padding, top + chartH);
    ctx.lineTo(padding + chartW, top + chartH);
    ctx.stroke();
    // Y ticks
    ctx.fillStyle = '#94a3b8'; ctx.font = '12px system-ui';
    const ticks = 4;
    for (let i=0;i<=ticks;i++){
      const y = top + chartH - (chartH * i / ticks);
      const val = maxVal * i / ticks;
      ctx.fillText(formatShort(val), 4, y + 4);
      ctx.strokeStyle = 'rgba(148,163,184,0.2)';
      ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(padding + chartW, y); ctx.stroke();
    }
    // Bars
    for (let si=0; si<sCount; si++){
      ctx.fillStyle = colors[si % colors.length];
      for (let i=0; i<n; i++){
        const x = padding + i*groupW + 4 + si*barW;
        const val = series[si][i] || 0;
        const h = Math.max(0, Math.round(val / maxVal * chartH));
        const y = top + chartH - h;
        ctx.fillRect(x, y, barW-2, h);
      }
    }
    // X labels
    ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
    for (let i=0;i<n;i++){
      const x = padding + i*groupW + groupW/2;
      ctx.fillText(String(labels[i]).slice(0,12), x, top + chartH + 16);
    }
    if (title) { ctx.textAlign = 'left'; ctx.fillText(title, padding, 14); }
  }

  const formatShort = (v) => {
    if (v >= 1_000_000) return (v/1_000_000).toFixed(1)+'M';
    if (v >= 1_000) return (v/1_000).toFixed(1)+'k';
    return Math.round(v).toString();
  };

  function updateCharts(list) {
    // Categoría: dos series (emitidas, recibidas)
    const byCat = new Map();
    for (const inv of list) {
      const key = (inv.category || '—');
      if (!byCat.has(key)) byCat.set(key, { emit:0, rec:0 });
      const base = Number(inv.base)||0; const iva = base * (Number(inv.ivaPct)||0)/100; const total = base + iva;
      if (inv.type === 'emitida') byCat.get(key).emit += total; else byCat.get(key).rec += total;
    }
    const catLabels = Array.from(byCat.keys());
    const catEmit = catLabels.map(k => byCat.get(k).emit);
    const catRec = catLabels.map(k => byCat.get(k).rec);
    drawBarChart($('#chart-categoria'), {
      labels: catLabels,
      series: [catEmit, catRec],
      colors: ['#2563eb', '#22c55e'],
      title: ''
    });

    // Mes: formateado YYYY-MM
    const byMonth = new Map();
    for (const inv of list) {
      const d = new Date(inv.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!byMonth.has(key)) byMonth.set(key, { emit:0, rec:0 });
      const base = Number(inv.base)||0; const iva = base * (Number(inv.ivaPct)||0)/100; const total = base + iva;
      if (inv.type === 'emitida') byMonth.get(key).emit += total; else byMonth.get(key).rec += total;
    }
    const months = Array.from(byMonth.keys()).sort();
    const mEmit = months.map(k => byMonth.get(k).emit);
    const mRec = months.map(k => byMonth.get(k).rec);
    drawBarChart($('#chart-mes'), {
      labels: months,
      series: [mEmit, mRec],
      colors: ['#2563eb', '#22c55e'],
      title: ''
    });
  }

  // ---------- Form y acciones ----------
  function openModal(editing = false, inv = null) {
    $('#modal-title').textContent = editing ? 'Editar factura' : 'Nueva factura';
    $('#modal').classList.remove('hidden');
    if (editing && inv) fillForm(inv); else resetForm();
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    clearPdfPreview();
  }
  function resetForm() {
    $('#form-invoice').reset();
    $('#inv-id').value = '';
    $('#inv-date').value = ymd(new Date());
    $('#inv-type').value = 'emitida';
    $('#inv-iva').value = '21';
    updateTotalField();
  }
  function fillForm(inv) {
    $('#inv-id').value = inv.id;
    $('#inv-number').value = inv.number || '';
    $('#inv-date').value = inv.date || '';
    $('#inv-type').value = inv.type || 'emitida';
    $('#inv-entity').value = inv.entity || '';
    $('#inv-concept').value = inv.concept || '';
    $('#inv-base').value = inv.base ?? '';
    $('#inv-iva').value = inv.ivaPct ?? 21;
    $('#inv-total').value = ((Number(inv.base)||0) * (1 + (Number(inv.ivaPct)||0)/100)).toFixed(2);
    $('#inv-payment').value = inv.payment || '';
    $('#inv-category').value = inv.category || '';
    $('#inv-notes').value = inv.notes || '';
    $('#inv-pdfpath').value = inv.pdfPath || '';
    $('#inv-archived').checked = !!inv.archived;
    clearPdfPreview();
  }

  function collectForm() {
    const id = $('#inv-id').value || uuid();
    const number = $('#inv-number').value.trim();
    const date = $('#inv-date').value;
    const type = $('#inv-type').value;
    const entity = $('#inv-entity').value.trim();
    const concept = $('#inv-concept').value.trim();
    const base = parseFloat($('#inv-base').value || '0');
    const ivaPct = parseFloat($('#inv-iva').value || '0');
    const payment = $('#inv-payment').value.trim();
    const category = $('#inv-category').value.trim();
    const notes = $('#inv-notes').value.trim();
    const pdfPath = $('#inv-pdfpath').value.trim();
    const archived = $('#inv-archived').checked;
    return { id, number, date, type, entity, concept, base, ivaPct, payment, category, notes, pdfPath, archived };
  }

  function updateTotalField() {
    const base = parseFloat($('#inv-base').value || '0');
    const ivaPct = parseFloat($('#inv-iva').value || '0');
    const total = base * (1 + (ivaPct/100));
    $('#inv-total').value = isFinite(total) ? total.toFixed(2) : '';
  }

  function clearPdfPreview() {
    const iframe = $('#pdf-preview');
    iframe.src = '';
    if (currentPdfObjectUrl) URL.revokeObjectURL(currentPdfObjectUrl);
    currentPdfObjectUrl = null;
  }

  function handlePdfSelection() {
    const file = $('#inv-pdf-file').files[0];
    clearPdfPreview();
    if (file && file.type === 'application/pdf') {
      currentPdfObjectUrl = URL.createObjectURL(file);
      $('#pdf-preview').src = currentPdfObjectUrl;
    }
  }

  async function loadAll() {
    invoices = await dbGetAll();
    render();
  }

  function render() {
    const filtered = applyFilters(invoices);
    updateKPIs(filtered);
    renderTable(filtered);
    updateCharts(filtered);
  }

  async function saveInvoice(e) {
    e.preventDefault();
    const inv = collectForm();
    // Validaciones
    if (!inv.number) return alert('El número de factura es obligatorio');
    if (!inv.date) return alert('La fecha es obligatoria');
    if (!inv.entity) return alert('El cliente/proveedor es obligatorio');
    if (!inv.concept) return alert('El concepto es obligatorio');
    if (isNaN(inv.base) || inv.base < 0) return alert('La base imponible no es válida');
    // Duplicados por número (único globalmente)
    const dup = invoices.find(x => x.number === inv.number && x.id !== inv.id);
    if (dup) return alert('Ya existe una factura con ese número');

    // Alta/edición
    const isNew = !invoices.some(x => x.id === inv.id);
    if (isNew) await dbAdd(inv); else await dbPut(inv);
    await loadAll();
    closeModal();
  }

  async function handleTableClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    const inv = invoices.find(x => x.id === id);
    if (!inv) return;
    if (action === 'edit') {
      openModal(true, inv);
    } else if (action === 'delete') {
      if (confirmDialog('¿Eliminar esta factura?')) {
        await dbDelete(id); await loadAll();
      }
    } else if (action === 'archive') {
      inv.archived = !inv.archived;
      await dbPut(inv); await loadAll();
    }
  }

  function exportJSON() {
    const data = JSON.stringify(invoices, null, 2);
    download('facturas_backup.json', new Blob([data], { type: 'application/json' }));
  }
  function exportCSV() {
    const headers = ['id','number','date','type','entity','concept','base','ivaPct','payment','category','notes','pdfPath','archived'];
    const rows = invoices.map(inv => headers.map(h => String(inv[h] ?? '').replaceAll('"','""')));
    const csv = [headers.join(','), ...rows.map(r => r.map(c => /[",\n]/.test(c) ? '"'+c+'"' : c).join(','))].join('\n');
    download('facturas.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }
  function download(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function handleImportFile() {
    const input = $('#input-import');
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const arr = JSON.parse(reader.result);
        if (!Array.isArray(arr)) throw new Error('Formato inválido');
        if (!confirmDialog('Esta acción reemplazará los datos actuales. ¿Continuar?')) return;
        // Normalización básica
        const norm = arr.map(x => ({
          id: x.id || uuid(),
          number: String(x.number||'').trim(),
          date: x.date || '',
          type: x.type === 'recibida' ? 'recibida' : 'emitida',
          entity: x.entity || '',
          concept: x.concept || '',
          base: Number(x.base)||0,
          ivaPct: Number(x.ivaPct)||0,
          payment: x.payment || '',
          category: x.category || '',
          notes: x.notes || '',
          pdfPath: x.pdfPath || '',
          archived: !!x.archived
        }));
        await dbClearAndImport(norm);
        await loadAll();
        alert('Datos restaurados correctamente');
      } catch (err) {
        alert('No se pudo importar el archivo: ' + err.message);
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // ---------- Eventos ----------
  function bindEvents() {
    $('#btn-new').addEventListener('click', () => openModal(false));
    $('#btn-close-modal').addEventListener('click', closeModal);
    $('#btn-cancel').addEventListener('click', closeModal);
    $('#form-invoice').addEventListener('submit', saveInvoice);
    $('#inv-base').addEventListener('input', updateTotalField);
    $('#inv-iva').addEventListener('input', updateTotalField);
    $('#inv-pdf-file').addEventListener('change', handlePdfSelection);

    $('#table-invoices').addEventListener('click', (e) => { handleTableClick(e); });

    $('#filters-form').addEventListener('submit', (e) => { e.preventDefault(); render(); });
    $('#btn-clear-filters').addEventListener('click', () => { $('#filters-form').reset(); render(); });

    $('#btn-export-json').addEventListener('click', exportJSON);
    $('#btn-export-csv').addEventListener('click', exportCSV);
    $('#input-import').addEventListener('change', handleImportFile);

    $('#input-irpf').addEventListener('change', () => {
      const v = parseFloat($('#input-irpf').value || '0');
      settings.irpfPct = Math.max(0, Math.min(100, isNaN(v)?0:v));
      render();
    });
    $('#toggle-theme').addEventListener('change', () => { settings.themeDark = $('#toggle-theme').checked; applyTheme(); });
  }

  // ---------- Inicio ----------
  window.addEventListener('DOMContentLoaded', async () => {
    // Cargar ajustes
    $('#input-irpf').value = String(settings.irpfPct);
    applyTheme();
    bindEvents();
    await idbOpen();
    await loadAll();
  });

})();

