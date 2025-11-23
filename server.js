import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import archiver from "archiver";
import { scrapeAllProducts } from "./scraper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Логирование входящих запросов — полезно при отладке и для истории
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const port = process.env.PORT || 3000;

// Maps for run state
// Хранилища состояния выполнения парсинга в памяти:
// - sseClients: для отправки событий по SSE клиентам, подписанным на runId
// - csvStore: хранит готовый CSV и метаданные (filename, articles) для каждого runId
// - runControllers: AbortController для возможности отмены фонового парсинга
const sseClients = new Map(); // runId -> Set(res)
const csvStore = new Map(); // runId -> {csv, filename, articles}
const runControllers = new Map(); // runId -> AbortController

// История запусков парсинга (также будет записываться в history.json)
const HISTORY_PATH = path.join(__dirname, "history.json");
let historyStore = null; // lazy load

const CONFIG_PATH = path.join(__dirname, "config.js");
const REPLACE_JSON_PATH = path.join(__dirname, "replaceNames.json");
const OUT_DIR = path.join(__dirname, 'out');

function extractTitlesFromProducts(products, fallbackArticles) {
  try {
    if (Array.isArray(products) && products.length > 0) {
      return products.map(p => (p && (p.title || p.article)) ? (p.title || p.article) : '').filter(Boolean);
    }
  } catch (e) {}
  // fallback to articles list
  if (Array.isArray(fallbackArticles)) return fallbackArticles.slice();
  return [];
}

function sanitizeName(name) {
  if (!name) return 'item';
  return String(name).replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function saveArtifacts(filename, csvString, products) {
  console.log(`saveArtifacts: start for ${filename}, products: ${Array.isArray(products) ? products.length : 0}`);
  // Создаём папку out/<filenameWithoutExt>/
  const base = filename.replace(/\.csv$/i, '');
  const destRoot = path.join(OUT_DIR, base);
  await fs.mkdir(destRoot, { recursive: true });

  // Сохраняем CSV в корень архива
  const csvPath = path.join(destRoot, filename);
  await fs.writeFile(csvPath, csvString, 'utf8');

  // Проходим по продуктам и скачиваем документы/сертификаты
  if (Array.isArray(products)) {
    for (let i = 0; i < products.length; i++) {
      const p = products[i] || {};
      const titleRaw = p.title || p.article || `product_${i+1}`;
      const prodName = sanitizeName(titleRaw);
      const prodDir = path.join(destRoot, prodName);
      // detect doc keys and cert keys
      const docEntries = Object.entries(p).filter(([k,v]) => k && /^doc\d+/i.test(k) && v);
      const certEntries = Object.entries(p).filter(([k,v]) => k && /^cert\d+/i.test(k) && v);

      if (docEntries.length > 0) {
        const docsDir = path.join(prodDir, 'Документы');
        await fs.mkdir(docsDir, { recursive: true });
        for (let j = 0; j < docEntries.length; j++) {
          const url = docEntries[j][1];
          try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            let fname = null;
            const cd = resp.headers.get('content-disposition');
            if (cd) {
              const m = /filename\*=UTF-8''([^;\n]+)/i.exec(cd) || /filename="?([^";\n]+)"?/i.exec(cd);
              if (m) fname = decodeURIComponent(m[1]);
            }
            if (!fname) {
              try { fname = decodeURIComponent(new URL(url).pathname.split('/').pop() || `document_${j+1}`); } catch { fname = `document_${j+1}`; }
            }
            const savePath = path.join(docsDir, sanitizeName(fname));
            const buf = Buffer.from(await resp.arrayBuffer());
            await fs.writeFile(savePath, buf);
          } catch (e) {
            console.error('Failed to download doc', url, e && e.message);
          }
        }
      }

      if (certEntries.length > 0) {
        const certsDir = path.join(prodDir, 'Сертификаты');
        await fs.mkdir(certsDir, { recursive: true });
        for (let j = 0; j < certEntries.length; j++) {
          const url = certEntries[j][1];
          try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            let fname = null;
            const cd = resp.headers.get('content-disposition');
            if (cd) {
              const m = /filename\*=UTF-8''([^;\n]+)/i.exec(cd) || /filename="?([^";\n]+)"?/i.exec(cd);
              if (m) fname = decodeURIComponent(m[1]);
            }
            if (!fname) {
              try { fname = decodeURIComponent(new URL(url).pathname.split('/').pop() || `cert_${j+1}`); } catch { fname = `cert_${j+1}`; }
            }
            const savePath = path.join(certsDir, sanitizeName(fname));
            const buf = Buffer.from(await resp.arrayBuffer());
            await fs.writeFile(savePath, buf);
          } catch (e) {
            console.error('Failed to download cert', url, e && e.message);
          }
        }
      }
    }
  }

  // Архивируем папку destRoot в ZIP с именем <filename base>.zip рядом в OUT_DIR
  const zipName = `${base}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  // ensure OUT_DIR exists
  await fs.mkdir(OUT_DIR, { recursive: true });
  await new Promise((resolvePromise, rejectPromise) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolvePromise());
    archive.on('error', (err) => rejectPromise(err));
    archive.pipe(output);
    // добавляем содержимое destRoot в корень архива
    archive.directory(destRoot, false);
    archive.finalize();
  });

  console.log(`saveArtifacts: zip created ${zipPath}`);

  return { zipPath, zipName };
}

async function readHistory() {
  if (historyStore) return historyStore;
  try {
    const txt = await fs.readFile(HISTORY_PATH, 'utf8');
    historyStore = JSON.parse(txt || '[]');
  } catch (e) {
    historyStore = [];
  }
  return historyStore;
}

async function writeHistory() {
  try {
    if (!historyStore) historyStore = [];
    await fs.writeFile(HISTORY_PATH, JSON.stringify(historyStore, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write history.json:', e && e.message);
  }
}

async function readReplaceNamesJson() {
  try {
    const txt = await fs.readFile(REPLACE_JSON_PATH, 'utf8');
    return JSON.parse(txt || '{}');
  } catch (e) {
    return null;
  }
}

async function writeReplaceNamesJson(obj) {
  try {
    await fs.writeFile(REPLACE_JSON_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    // ignore write errors for now
    console.error('Failed to write replaceNames.json:', e && e.message);
  }
}

async function readConfig() {
  try {
    // prefer JSON file for replaceNames if present
    let replaceNames = await readReplaceNamesJson();
    const txt = await fs.readFile(CONFIG_PATH, "utf8");
    const replaceMatch = txt.match(/export\s+const\s+replaceNames\s*=\s*({[\s\S]*?});/);
    const articlesMatch = txt.match(/export\s+const\s+articles\s*=\s*(\[[\s\S]*?\]);/);
    let articles = [];
    if (!replaceNames && replaceMatch) {
      // fallback to parsing replaceNames from config.js
      // eslint-disable-next-line no-new-func
      replaceNames = Function(`return ${replaceMatch[1]}`)();
    }
    if (articlesMatch) {
      // eslint-disable-next-line no-new-func
      articles = Function(`return ${articlesMatch[1]}`)();
    }
    replaceNames = replaceNames || {};
    return { replaceNames, articles };
  } catch (e) {
    return { replaceNames: {}, articles: [] };
  }
}

async function writeConfig(replaceNames, articles) {
  const content = `// === ЗАМЕНА ДЛИННЫХ ИМЁН ===\nexport const replaceNames = ${JSON.stringify(replaceNames, null, 2)};\n\n// === АРТИКУЛИ ===\nexport const articles = ${JSON.stringify(articles, null, 2)};\n`;
  await fs.writeFile(CONFIG_PATH, content, "utf8");
  // also persist as JSON for faster reloads and robustness
  await writeReplaceNamesJson(replaceNames);
}

function sendSSE(runId, event, data) {
  const clients = sseClients.get(runId);
  if (!clients) return;
  for (const res of clients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // ignore
    }
  }
}

app.get("/events/:runId", (req, res) => {
  const runId = req.params.runId;
  res.writeHead(200, {
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });

  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  sseClients.get(runId).add(res);

  req.on("close", () => {
    const set = sseClients.get(runId);
    if (set) set.delete(res);
  });
});

app.get('/replace-names', async (req, res) => {
  try {
    const cfg = await readConfig();
    res.json({ replaceNames: cfg.replaceNames || {} });
  } catch (e) {
    res.json({ replaceNames: {} });
  }
});

// JSON alias (some clients may prefer explicit .json path)
app.get('/replace-names.json', async (req, res) => {
  try {
    const cfg = await readConfig();
    console.log('/replace-names.json requested');
    res.json({ replaceNames: cfg.replaceNames || {} });
  } catch (e) {
    res.json({ replaceNames: {} });
  }
});

// API-prefixed alias to avoid static middleware conflicts
app.get('/api/replace-names.json', async (req, res) => {
  try {
    const cfg = await readConfig();
    console.log('/api/replace-names.json requested');
    res.json({ replaceNames: cfg.replaceNames || {} });
  } catch (e) {
    res.json({ replaceNames: {} });
  }
});

app.get('/api/ping', (req, res) => {
  console.log('/api/ping requested');
  res.json({ ok: true, pid: process.pid });
});

// Возвращает историю запусков парсинга (последние записи первыми)
app.get('/api/history', async (req, res) => {
  try {
    const hist = await readHistory();
    res.json({ ok: true, history: hist });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Debug: explicit regex route to catch any replace-names requests (covers variants)
app.get(/replace-names(\.json)?$/i, async (req, res) => {
  try {
    console.log(`Caught replace-names request at ${req.path}`);
    const cfg = await readConfig();
    return res.json({ replaceNames: cfg.replaceNames || {} });
  } catch (e) {
    return res.status(500).json({ replaceNames: {}, error: e.message });
  }
});

// Debug endpoint to list registered routes
app.get('/__routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      routes.push({ path: r.route.path, methods: r.route.methods });
    }
  });
  res.json({ routes, pid: process.pid });
});

app.post('/save-replacements', async (req, res) => {
  try {
    const body = req.body || {};
    const replaceMap = body.replaceMap || {};
    const cfg = await readConfig();
    const articles = cfg.articles && cfg.articles.length ? cfg.articles : [];
    await writeConfig(replaceMap, articles);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/start", async (req, res) => {
  const articles = Array.isArray(req.body.articles) ? req.body.articles : [];
  const runId = Date.now().toString();
  csvStore.set(runId, { csv: null, filename: null, articles });

  // Start scraping in background
  (async () => {
    const controller = new AbortController();
    runControllers.set(runId, controller);
    try {
      const onLog = (msg) => sendSSE(runId, "log", { message: msg });
      const cfg = await readConfig();
      const result = await scrapeAllProducts(articles, cfg.replaceNames || {}, onLog, controller.signal);
      console.log(`Run ${runId} finished, result keys: ${result ? Object.keys(result).join(',') : 'null'}`);

      if (result && result.needReplacements) {
        // send list of problem phrases
        sendSSE(runId, "need_replacements", { longNames: result.longNames });
        // Добавляем запись в историю как требующую вмешательства
        const hist = await readHistory();
        // titles неизвестны на этом шаге (парсинг вернул только longNames), сохраняем переданные артикула как fallback
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'need_replacements', titles: articles, message: 'Требуются замены длинных имён', longNames: result.longNames });
        await writeHistory();

      } else if (result && result.csv) {
        // Сохраняем артефакты (CSV + скачанные документы/сертификаты) и упаковываем в ZIP
        try {
          // ensure filename exists
          if (!result.filename) {
            const now = new Date();
            result.filename = `tinko_products_${now.toISOString().replace(/[:.]/g,'-')}.csv`;
          }
          const artifacts = await saveArtifacts(result.filename, result.csv, result.products || []);
          const titles = extractTitlesFromProducts(result.products, articles);
          csvStore.set(runId, { csv: result.csv, filename: result.filename, articles, titles, archive: artifacts.zipPath, archiveName: artifacts.zipName });
          // отправляем имя архива клиенту
          sendSSE(runId, "done", { filename: result.filename, archive: artifacts.zipName });
          // Сохраняем запись об успешном завершении в историю (с названиями товаров)
          const hist = await readHistory();
          hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'done', titles, filename: result.filename, archive: artifacts.zipName });
          await writeHistory();
        } catch (e) {
          sendSSE(runId, "error", { message: 'Ошибка при сохранении артефактов: ' + (e && e.message) });
          const hist = await readHistory();
          const titles = extractTitlesFromProducts(result && result.products, articles);
          hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', titles, message: 'Ошибка при сохранении артефактов: ' + (e && e.message) });
          await writeHistory();
        }

      } else {
        sendSSE(runId, "error", { message: "Парсинг завершился без результата" });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', titles: articles, message: 'Парсинг завершился без результата' });
        await writeHistory();
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        sendSSE(runId, 'cancelled', { message: 'Парсинг отменён' });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'cancelled', titles: articles, message: 'Парсинг отменён пользователем' });
        await writeHistory();
      } else {
        sendSSE(runId, "error", { message: err.message });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', titles: articles, message: err.message });
        await writeHistory();
      }
    } finally {
      runControllers.delete(runId);
    }
  })();

  res.json({ runId });
});

app.post("/apply-replacements", async (req, res) => {
  const { runId, replaceMap } = req.body;
  const state = csvStore.get(runId);
  if (!state) return res.status(400).json({ error: "Unknown runId" });

  // persist replacements to config.js (merge with existing)
  (async () => {
    try {
      const cfg = await readConfig();
      const merged = Object.assign({}, cfg.replaceNames || {}, replaceMap || {});
      const articlesToWrite = cfg.articles && cfg.articles.length ? cfg.articles : state.articles;
      await writeConfig(merged, articlesToWrite);

      // Cancel any existing run controller for this runId (we'll start a fresh run)
      const existingController = runControllers.get(runId);
      if (existingController) {
        try { existingController.abort(); } catch (e) {}
        runControllers.delete(runId);
      }

      const controller = new AbortController();
      runControllers.set(runId, controller);

      const onLog = (msg) => sendSSE(runId, "log", { message: msg });
      const result = await scrapeAllProducts(state.articles, merged, onLog, controller.signal);
  console.log(`Apply-replacements run ${runId} finished, result keys: ${result ? Object.keys(result).join(',') : 'null'}`);
      if (result && result.needReplacements) {
        sendSSE(runId, "need_replacements", { longNames: result.longNames });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'need_replacements', articles: state.articles, message: 'Требуются замены длинных имён', longNames: result.longNames });
        await writeHistory();
      } else if (result && result.csv) {
        try {
          if (!result.filename) {
            const now = new Date();
            result.filename = `tinko_products_${now.toISOString().replace(/[:.]/g,'-')}.csv`;
          }
          const artifacts = await saveArtifacts(result.filename, result.csv, result.products || []);
          csvStore.set(runId, { csv: result.csv, filename: result.filename, articles: state.articles, archive: artifacts.zipPath, archiveName: artifacts.zipName });
          sendSSE(runId, "done", { filename: result.filename, archive: artifacts.zipName });
          const hist = await readHistory();
          hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'done', articles: state.articles, filename: result.filename, archive: artifacts.zipName });
          await writeHistory();
        } catch (e) {
          sendSSE(runId, "error", { message: 'Ошибка при сохранении артефактов: ' + (e && e.message) });
          const hist = await readHistory();
          hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', articles: state.articles, message: 'Ошибка при сохранении артефактов: ' + (e && e.message) });
          await writeHistory();
        }
      } else {
        sendSSE(runId, "error", { message: "Парсинг завершился без результата" });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', articles: state.articles, message: 'Парсинг завершился без результата' });
        await writeHistory();
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        sendSSE(runId, 'cancelled', { message: 'Парсинг отменён' });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'cancelled', articles: state.articles, message: 'Парсинг отменён пользователем' });
        await writeHistory();
      } else {
        sendSSE(runId, "error", { message: err.message });
        const hist = await readHistory();
        hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'error', articles: state.articles, message: err.message });
        await writeHistory();
      }
    } finally {
      runControllers.delete(runId);
    }
  })();

  res.json({ ok: true });
});

app.post('/cancel', async (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ error: 'Missing runId' });
  try {
    const controller = runControllers.get(runId);
    if (controller) {
      try { controller.abort(); } catch (e) {}
      runControllers.delete(runId);
    }

    sendSSE(runId, 'cancelled', { message: 'Парсинг отменён пользователем' });

    try {
      const hist = await readHistory();
      const state = csvStore.get(runId) || {};
      const titles = state.titles || state.articles || [];
      hist.unshift({ runId, timestamp: new Date().toISOString(), status: 'cancelled', titles, message: 'Отмена пользователем' });
      await writeHistory();
    } catch (e) {
      console.error('Failed to record manual cancel in history:', e && e.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message });
  }
});

// Скачать ZIP с CSV и папками документов/сертификатов
app.get('/download-zip/:runId', (req, res) => {
  const runId = req.params.runId;
  (async () => {
    const state = csvStore.get(runId);
    if (state && state.archive) {
      const zipPath = state.archive;
      const zipName = state.archiveName || path.basename(zipPath);
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Content-Type', 'application/zip');
      return res.sendFile(zipPath);
    }

    // fallback: try history.json
    try {
      const hist = await readHistory();
      const rec = (hist || []).find(h => String(h.runId) === String(runId));
      if (rec && rec.archive) {
        const zipPath = path.join(OUT_DIR, rec.archive);
        try {
          await fs.access(zipPath);
          res.setHeader('Content-Disposition', `attachment; filename="${rec.archive}"`);
          res.setHeader('Content-Type', 'application/zip');
          return res.sendFile(zipPath);
        } catch (e) {
          return res.status(404).send('Archive file missing on disk');
        }
      }
    } catch (e) {
      // ignore
    }

    return res.status(404).send('Archive not found');
  })();
});

// Extra aliases for history endpoints to avoid 404s due to different client URLs
app.get('/history.json', async (req, res) => {
  try {
    const hist = await readHistory();
    res.json(hist);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history.json', async (req, res) => {
  try {
    const hist = await readHistory();
    res.json({ ok: true, history: hist });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve static files after API routes to avoid middleware conflicts
app.use(express.static(path.join(__dirname, "public")));

app.listen(port, () => {
  console.log(`GUI server started: http://localhost:${port}`);
  // Инициализация: гарантируем, что history.json и папка out существуют
  (async () => {
    try {
      await fs.mkdir(OUT_DIR, { recursive: true });
    } catch (e) {
      console.error('Failed to ensure OUT_DIR:', e && e.message);
    }
    try {
      const hist = await readHistory();
      // если файл не существовал, writeHistory создаст его
      await writeHistory();
      console.log(`History initialized, ${hist.length} entries`);
    } catch (e) {
      console.error('Failed to initialize history.json:', e && e.message);
    }
  })();
});
