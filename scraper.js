import { chromium } from "playwright";
import { load } from "cheerio";
import { resolve } from "url";
import ObjectsToCsv from "objects-to-csv";

const baseUrl = "https://www.tinko.ru/catalog/";
const delayBetweenRequests = 2000;

/**
 * Scrape function used by the GUI server.
 * @param {string[]} articles
 * @param {Object} replaceNames - map of replacements for long attribute names
 * @param {(msg:string)=>void} onLog - callback for log messages
 * @returns {Promise<{needReplacements:boolean,longNames:string[],csv?:string,filename?:string}>}
 */
export async function scrapeAllProducts(articles, replaceNames = {}, onLog = () => {}, signal = undefined) {
  const products = [];
  const longCharsNames = new Set();

  onLog(`Запуск парсинга (${articles.length} артикула)`);

    // Запускаем безголовый хром
    const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  for (let i = 0; i < articles.length; i++) {
    // Проходим по каждому артикулу последовательно
    if (signal && signal.aborted) {
      onLog('Парсинг отменён пользователем');
      break;
    }
    const article = (articles[i] || "").trim();
    const productUrl = resolve(baseUrl, `product/${article}`);

    onLog(`[${i + 1}/${articles.length}] Парсим: ${article}`);

    const product = { article };

    try {
      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      const html = await page.content();
      const $ = load(html);

      const title = $(".page-title h1").text().trim();
      const subTitle = $(".product-detail__row-1").find("h2").text().trim();
      const fullTitle = `${subTitle} ${title}`.trim();
      if (fullTitle) product["title"] = fullTitle;

      const manufacturer = $(".product-detail__property").eq(1).find("a").text().trim();
      if (manufacturer) product["manufacturer"] = manufacturer;

      const priceText = $(".product-detail__price-value").eq(0).text().replace(/\s/g, "").replace(/,.*$/, "");
      if (priceText && !isNaN(parseInt(priceText))) {
        product["price"] = parseInt(priceText, 10);
      }

      const description = $(".product-detail__short-description span").text().trim();
      if (description) product["description"] = description;

      const imgSrc = $(".product-images-slider__main-slide img").attr("src");
      if (imgSrc) product["image"] = resolve(baseUrl, imgSrc);

      const $chars = $(".product-detail__characteristic-column");
      if ($chars.length > 0) {
        let attrIndex = 1;
        $chars.each(function () {
          let name = $(this).find("p").eq(0).text().trim();
          const value = $(this).find("p").eq(1).text().trim();

          if (name && value) {
            if (replaceNames && replaceNames[name]) {
              name = replaceNames[name];
            }

            if (name.length >= 28) {
              longCharsNames.add(name);
            }

            product[`Attribute ${attrIndex} name`] = name;
            product[`Attribute ${attrIndex} value`] = value;
            attrIndex++;
          }
        });
      }

      const $docs = $(".product-detail__documentation-item");
      if ($docs.length > 0) {
        let docIndex = 1;
        $docs.each(function () {
          const name = $(this).find(".product-detail__documentation-item-name").text().trim();
          const href = $(this).find("a").attr("href");
          if (name && href) {
            product[`doc${docIndex}`] = resolve(baseUrl, href);
            docIndex++;
          }
        });
      }

      const $certs = $(".product-detail__certificates-link a");
      if ($certs.length > 0) {
        let certIndex = 1;
        $certs.each(function () {
          const href = $(this).attr("href");
          if (href) {
            product[`cert${certIndex}`] = resolve(baseUrl, href);
            certIndex++;
          }
        });
      }

      products.push(product);
      onLog(`Успех: ${product["title"] || article}`);
    } catch (error) {
      onLog(`Ошибка с артикулом ${article}: ${error.message}`);
      products.push({ Артикул: article, URL: productUrl, Ошибка: error.message.substring(0, 200) });
    }

    if (i < articles.length - 1) await new Promise((r) => setTimeout(r, delayBetweenRequests));
  }

  try {
    await context.close();
    await browser.close();
  } catch (e) {
    // ignore
  }

  if (longCharsNames.size >= 1) {
    onLog("Найдены длинные имена атрибутов, требуется вмешательство пользователя.");
    return { needReplacements: true, longNames: Array.from(longCharsNames) };
  }

  // build csv
  if (products.length > 0) {
    // Для CSV исключаем поля с ссылками на документы и сертификаты
    const sanitized = products.map((p) => {
      const out = {};
      for (const k of Object.keys(p)) {
        if (/^doc\d+/i.test(k)) continue;
        if (/^cert\d+/i.test(k)) continue;
        out[k] = p[k];
      }
      return out;
    });

    const csv = new ObjectsToCsv(sanitized);
    const csvString = await csv.toString();
    const now = new Date();
    const dateString = now.toLocaleString("ru-RU").replace(/[\/:,]/g, "-").replace(/\s/g, "_");
    const filename = `tinko_products_${dateString}.csv`;
    onLog(`Парсинг завершён. CSV готов: ${filename}`);
    // prepend BOM so Excel shows Cyrillic correctly
    return { needReplacements: false, longNames: [], csv: '\uFEFF' + csvString, filename, products };
  }

  return { needReplacements: false, longNames: [], csv: '', filename: 'tinko_products.csv' };
}
