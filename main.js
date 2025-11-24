(() => {
  const articleInput = document.getElementById("articleInput");
  const addBtn = document.getElementById("addBtn");
  const clearBtn = document.getElementById("clearBtn");
  const editReplacementsBtn = document.getElementById("editReplacementsBtn");
  const historyBtn = document.getElementById("historyBtn");
  const articlesList = document.getElementById("articlesList");
  const startBtn = document.getElementById("startBtn");
  const logArea = document.getElementById("logArea");
  const loader = document.getElementById("loader");
  const downloadBtn = document.getElementById("downloadBtn");

  const modal = document.getElementById("modal");
  const replaceForm = document.getElementById("replaceForm");
  const applyReplacementsBtn = document.getElementById("applyReplacementsBtn");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const historyModal = document.getElementById('historyModal');
  const historyList = document.getElementById('historyList');
  const closeHistoryBtn = document.getElementById('closeHistoryBtn');
  // action button starts disabled until form validated
  applyReplacementsBtn.disabled = true;

  function addArticleToList(text) {
    const li = document.createElement("li");
    li.textContent = text;
    const remove = document.createElement("button");
    remove.textContent = "✖";
    remove.className = "remove";
    remove.onclick = () => li.remove();
    li.appendChild(remove);
    articlesList.appendChild(li);
  }

  addBtn.addEventListener("click", () => {
    const v = articleInput.value.trim();
    if (!v) return;
    addArticleToList(v);
    articleInput.value = "";
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm('Очистить список артикулов?')) return;
    articlesList.innerHTML = '';
  });

  editReplacementsBtn.addEventListener("click", async () => {
    // Try multiple endpoints to load replaceNames (helps when static middleware or proxies interfere)
    const candidates = ['/api/replace-names.json', '/replace-names.json', '/replace-names'];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) {
          lastErr = `HTTP ${resp.status} at ${url}`;
          continue;
        }
        const json = await resp.json();
        showEditModal(json.replaceNames || {});
        return;
      } catch (err) {
        lastErr = err && err.message;
      }
    }
    appendLog('Не удалось загрузить список замен: ' + lastErr);
  });

  // Показать модальное окно с историей запусков парсинга
  historyBtn.addEventListener('click', async () => {
    try {
      // Попытки нескольких вариантов URL — некоторые окружения/прокси могут менять путь
      const candidates = ['/api/history', '/api/history.json', '/history.json', '/history'];
      let lastResp = null;
      let j = null;
      for (const url of candidates) {
        try {
          const resp = await fetch(url, { cache: 'no-store' });
          lastResp = resp;
          if (!resp.ok) continue;
          // Try to parse possible shapes: {ok:true, history:[]} or array
          const body = await resp.json();
          if (Array.isArray(body)) { j = { ok: true, history: body }; break; }
          if (body && (body.history || Array.isArray(body))) { j = body; break; }
        } catch (err) {
          lastResp = null;
        }
      }
      if (!j) {
        appendLog('Не удалось получить историю: ' + (lastResp ? lastResp.status : 'network error'));
        return;
      }
      const hist = j.history || [];
      historyList.innerHTML = '';
      if (hist.length === 0) {
        historyList.textContent = 'История пуста';
      } else {
        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        hist.forEach(item => {
          const li = document.createElement('li');
          li.style.borderBottom = '1px solid #ddd';
          li.style.padding = '8px';
          const date = new Date(item.timestamp).toLocaleString();
          const status = item.status || '';
          const articles = Array.isArray(item.articles) ? item.articles.join(', ') : '';
          li.innerHTML = `<strong>${date}</strong> — <em>${status}</em><br/>Артикулы: ${articles}<br/>`;
            if (item.filename) {
              const a = document.createElement('a');
              // если архив сформирован, даём ссылку на ZIP, иначе на CSV
              if (item.archive) {
                a.href = `/download-zip/${item.runId}`;
                a.textContent = `Скачать архив ${item.archive}`;
              } else {
                a.href = `/download/${item.runId}`;
                a.textContent = `Скачать ${item.filename}`;
              }
              a.style.display = 'inline-block';
              a.style.marginTop = '6px';
              li.appendChild(a);
            }
          if (item.message) {
            const p = document.createElement('div');
            p.textContent = item.message;
            p.style.marginTop = '4px';
            li.appendChild(p);
          }
          ul.appendChild(li);
        });
        historyList.appendChild(ul);
      }
      historyModal.classList.remove('hidden');
    } catch (e) {
      appendLog('Ошибка получения истории: ' + (e && e.message));
    }
  });

  closeHistoryBtn.addEventListener('click', () => { historyModal.classList.add('hidden'); });

  function getArticles() {
    return Array.from(articlesList.querySelectorAll("li"))
      .map(li => li.firstChild.textContent.trim())
      .filter(Boolean);
  }

  function appendLog(text) {
    logArea.textContent += text + "\n";
    logArea.scrollTop = logArea.scrollHeight;
  }

  let currentRunId = null;
  let evtSource = null;

  startBtn.addEventListener("click", async () => {
    const articles = getArticles();
    if (articles.length === 0) return alert("Добавьте хотя бы один артикул");

    logArea.textContent = "";
    loader.classList.remove("hidden");
  downloadBtn.classList.add("hidden");

    const resp = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles }),
    });
    const json = await resp.json();
    currentRunId = json.runId;
    appendLog(`RunId: ${currentRunId}`);

    if (evtSource) evtSource.close();
    evtSource = new EventSource(`/events/${currentRunId}`);
    evtSource.addEventListener("log", (e) => {
      const data = JSON.parse(e.data);
      appendLog(data.message);
    });
    evtSource.addEventListener("need_replacements", (e) => {
      const data = JSON.parse(e.data);
      showResolveModal(data.longNames);
    });
    evtSource.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      loader.classList.add("hidden");
      appendLog("Готово. Архив доступен для скачивания.");
      const archiveName = data.archive || data.filename || 'archive.zip';
      downloadBtn.textContent = `Скачать ${archiveName}`;
      downloadBtn.classList.remove("hidden");
      downloadBtn.onclick = () => { window.location = `/download-zip/${currentRunId}`; };
      // clear articles list after successful parsing
      articlesList.innerHTML = '';
    });
    evtSource.addEventListener("cancelled", (e) => {
      try { const d = JSON.parse(e.data); appendLog(d.message || 'Отмена'); } catch { appendLog('Парсинг отменён'); }
      loader.classList.add("hidden");
      if (evtSource) { evtSource.close(); evtSource = null; }
    });
    evtSource.addEventListener("error", (e) => {
      try { const d = JSON.parse(e.data); appendLog(`Ошибка: ${d.message}`); } catch { appendLog('Ошибка сервера'); }
      loader.classList.add("hidden");
    });
  });

  function showResolveModal(longNames) {
    // mode: resolve long names -> label + input
    replaceForm.innerHTML = "";
    longNames.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "replace-row resolve-row";

      const label = document.createElement("label");
      label.textContent = name;

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Укороченное имя (меньше 28 символов)";
      input.dataset.orig = name;
      input.addEventListener('input', validateResolveForm);

      row.appendChild(label);
      row.appendChild(input);
      replaceForm.appendChild(row);
    });
    // configure modal for resolve mode
    modal.dataset.mode = 'resolve';
    applyReplacementsBtn.textContent = 'Парсить снова';
    // validate and enable/disable action button
    validateResolveForm();
    modal.classList.remove("hidden");
  }

  function showEditModal(replaceMap) {
    // mode: edit existing replaceNames -> rows with orig + value editable
    replaceForm.innerHTML = "";
    const rows = [];
    const addRow = (orig = '', val = '') => {
      const row = document.createElement('div');
      row.className = 'replace-row';

      const origInput = document.createElement('input');
      origInput.type = 'text';
      origInput.placeholder = 'Длинная фраза';
      origInput.className = 'orig-input';
      origInput.value = orig;

      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.placeholder = 'Замена (меньше 28 символов)';
      valInput.className = 'val-input';
      valInput.value = val;

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Удалить';
      del.onclick = () => row.remove();
      del.style.marginLeft = '8px';

      row.appendChild(origInput);
      row.appendChild(valInput);
      row.appendChild(del);
      replaceForm.appendChild(row);
      rows.push(row);
      return row;
    };

    // populate existing
    Object.keys(replaceMap).forEach(k => addRow(k, replaceMap[k]));

    // add control to add new row
    const addBtnRow = document.createElement('div');
    addBtnRow.style.marginTop = '8px';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Добавить строку';
    addBtn.onclick = () => {
      const r = addRow('', '');
      const origInput = r.querySelector('.orig-input');
      const valInput = r.querySelector('.val-input');
      origInput.addEventListener('input', validateEditForm);
      valInput.addEventListener('input', validateEditForm);
      validateEditForm();
    };
    addBtnRow.appendChild(addBtn);
    replaceForm.appendChild(addBtnRow);

    modal.dataset.mode = 'edit';
    applyReplacementsBtn.textContent = 'Сохранить';
    // attach listeners for validation on existing rows
    const rowsNow = Array.from(replaceForm.querySelectorAll('.replace-row'));
    rowsNow.forEach(r => {
      const origInput = r.querySelector('.orig-input');
      const valInput = r.querySelector('.val-input');
      if (origInput && valInput) {
        origInput.addEventListener('input', validateEditForm);
        valInput.addEventListener('input', validateEditForm);
      }
    });
    validateEditForm();
    modal.classList.remove('hidden');
  }

  applyReplacementsBtn.addEventListener("click", async () => {
    const mode = modal.dataset.mode || 'resolve';
    if (mode === 'resolve') {
      const inputs = Array.from(replaceForm.querySelectorAll('input'));
      const replaceMap = {};
      for (const input of inputs) {
        // resolve mode has label + input; only inputs are replacement fields
        const orig = input.dataset.orig || input.previousSibling && input.previousSibling.textContent;
        const val = input.value.trim();
        if (!val) return alert('Заполните все поля в форме');
        if (val.length >= 28) return alert('Каждое сокращение должно быть короче 28 символов');
        replaceMap[orig] = val;
      }
      // clear previous logs when restarting parse
      logArea.textContent = '';
      loader.classList.remove('hidden');
      appendLog('Пользователь применил замены, запускаю парсинг снова...');
      try {
        const resp = await fetch('/apply-replacements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: currentRunId, replaceMap }) });
        if (!resp.ok) appendLog('Ошибка при запуске парсинга после замен');
      } catch (e) {
        appendLog('Ошибка запроса apply-replacements: ' + (e && e.message));
      }
      modal.classList.add('hidden');
    } else if (mode === 'edit') {
      // collect orig & val pairs from rows
      const rows = Array.from(replaceForm.querySelectorAll('.replace-row'));
      const replaceMap = {};
      for (const row of rows) {
        const origInput = row.querySelector('.orig-input');
        const valInput = row.querySelector('.val-input');
        if (!origInput || !valInput) continue;
        const orig = origInput.value.trim();
        const val = valInput.value.trim();
        if (!orig) continue; // skip empty orig
        if (!val) return alert('Заполните все поля замен');
        if (val.length >= 28) return alert('Каждое сокращение должно быть короче 28 символов');
        replaceMap[orig] = val;
      }
      // save to server (replace entire replaceNames)
      try {
        const resp = await fetch('/save-replacements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replaceMap }) });
        if (!resp.ok) {
          appendLog('Ошибка при сохранении замен: ' + resp.status);
        } else {
          const j = await resp.json();
          if (j.ok) appendLog('Замены сохранены'); else appendLog('Ошибка при сохранении замен');
        }
      } catch (e) {
        appendLog('Не удалось сохранить замен: ' + (e && e.message));
      }
      modal.classList.add('hidden');
    }
  });
  closeModalBtn.addEventListener("click", async () => {
    const mode = modal.dataset.mode || '';
    modal.classList.add("hidden");
    if (mode === 'resolve') {
      // user cancelled the resolve modal while parsing => cancel the running parse
      appendLog('Пользователь отменил парсинг — отправляю запрос на отмену...');
      try {
        await fetch('/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: currentRunId }) });
        appendLog('Запрос на отмену отправлен');
      } catch (e) {
        appendLog('Не удалось отправить запрос на отмену');
      }
      loader.classList.add('hidden');
      if (evtSource) { evtSource.close(); evtSource = null; }
    } else {
      // in edit mode just close the modal
      appendLog('Окно редактирования закрыто');
    }
  });

  // Close modal on Escape
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!modal.classList.contains('hidden')) {
        closeModalBtn.click();
      }
    }
  });

  // Add article on Enter
  articleInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addBtn.click();
    }
  });

  // Validation helpers
  function validateResolveForm() {
    const inputs = Array.from(replaceForm.querySelectorAll('.resolve-row input'));
    if (inputs.length === 0) { applyReplacementsBtn.disabled = true; return; }
    for (const input of inputs) {
      const v = input.value.trim();
      if (!v || v.length >= 28) { applyReplacementsBtn.disabled = true; return; }
    }
    applyReplacementsBtn.disabled = false;
  }

  function validateEditForm() {
    const rows = Array.from(replaceForm.querySelectorAll('.replace-row'));
    // ignore the addBtnRow which doesn't contain inputs
    let anyRow = false;
    for (const row of rows) {
      const origInput = row.querySelector('.orig-input');
      const valInput = row.querySelector('.val-input');
      if (!origInput || !valInput) continue;
      const orig = origInput.value.trim();
      const val = valInput.value.trim();
      anyRow = true;
      if (!orig || !val || val.length >= 28) { applyReplacementsBtn.disabled = true; return; }
    }
    // if there are no editable rows, keep disabled
    applyReplacementsBtn.disabled = !anyRow ? true : false;
  }

})();
