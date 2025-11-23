import { chromium } from "playwright";
import { load } from "cheerio";
import { resolve } from "url";
import ObjectsToCsv from "objects-to-csv";
import { replaceNames, articles } from "./config.js";

const longCharsNames = new Set();

const baseUrl = "https://www.tinko.ru/catalog/";
const delayBetweenRequests = 2000;

// === ОСНОВНАЯ ФУНКЦИЯ ===
async function scrapeAllProducts(articles) {
  const products = [];

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i].trim();
    const productUrl = resolve(baseUrl, `product/${article}`);

    console.log(`[${i + 1}/${articles.length}] Парсим: ${article}`);

    const product = {
      article: article,
    };

    try {
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      const html = await page.content();
      const $ = load(html);

      // === Название ===
      const title = $(".page-title h1").text().trim();
      const subTitle = $(".product-detail__row-1").find("h2").text().trim();
      console.log(subTitle);
      const fullTitle = `${subTitle} ${title}`;
      if (fullTitle) product["title"] = fullTitle;

      // === Производитель ===
      const manufacturer = $(".product-detail__property")
        .eq(1)
        .find("a")
        .text()
        .trim();
      if (manufacturer) product["manufacturer"] = manufacturer;

      // === Цена ===
      const priceText = $(".product-detail__price-value")
        .eq(0)
        .text()
        .replace(/\s/g, "")
        .replace(/,.*$/, "");
      if (priceText && !isNaN(parseInt(priceText))) {
        product["price"] = parseInt(priceText, 10);
      }

      // === Описание ===
      const description = $(".product-detail__short-description span")
        .text()
        .trim();
      if (description) product["description"] = description;

      // === Главное изображение ===
      const imgSrc = $(".product-images-slider__main-slide img").attr("src");
      if (imgSrc) product["image"] = resolve(baseUrl, imgSrc);

      // === ХАРАКТЕРИСТИКИ ===
      const $chars = $(".product-detail__characteristic-column");
      if ($chars.length > 0) {
        let attrIndex = 1;
        $chars.each(function () {
          let name = $(this).find("p").eq(0).text().trim();
          const value = $(this).find("p").eq(1).text().trim();

          if (name && value) {
            // Реплейс имен атрибутов согласно replaceNames
            if (replaceNames[name]) {
              name = replaceNames[name];
            }

            // Проверка длины имени атрибута
            if (name.length >= 28) {
              longCharsNames.add(name);
            }

            // Записываем и короткое, и полное имя
            product[`Attribute ${attrIndex} name`] = name;
            product[`Attribute ${attrIndex} value`] = value;
            attrIndex++;
          }
        });
      }

      // === ДОКУМЕНТАЦИЯ ===
      const $docs = $(".product-detail__documentation-item");
      if ($docs.length > 0) {
        let docIndex = 1;
        $docs.each(function () {
          const name = $(this)
            .find(".product-detail__documentation-item-name")
            .text()
            .trim();
          const href = $(this).find("a").attr("href");
          if (name && href) {
            product[`doc${docIndex}`] = resolve(baseUrl, href);
            docIndex++;
          }
        });
      }

      // === СЕРТИФИКАТЫ ===
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
      console.log(`Успех: ${product["title"] || article}`);
    } catch (error) {
      console.error(`Ошибка с артикулом ${article}:`, error.message);
      products.push({
        Артикул: article,
        URL: productUrl,
        Ошибка: error.message.substring(0, 200),
      });
    }

    // Задержка перед следующим товаром
    if (i < articles.length - 1) {
      await new Promise((r) => setTimeout(r, delayBetweenRequests));
    }
  }

  await context.close();
  await browser.close();

  return products;
}

// === ЗАПУСК И СОХРАНЕНИЕ В CSV ===
(async () => {
  console.log("Запуск парсинга...");

  const result = await scrapeAllProducts(articles);

  console.log(`\nГотово! Обработано товаров: ${result.length}`);

  // === СОХРАНЕНИЕ В CSV ===
  if (result.length > 0) {
    const csv = new ObjectsToCsv(result);

    // Генерируем название файла с датой и временем в читаемом формате
    const now = new Date();
    const dateString = now
      .toLocaleString("ru-RU")
      .replace(/[/,:]/g, "-") // Заменяем /, : на -
      .replace(/\s/g, "_"); // Заменяем пробелы на _

    const filename = `tinko_products_${dateString}.csv`;

    // ВЫВОД В СТОЛБИК
    if (longCharsNames.size >= 1) {
      console.log("\nВнести в словарь (длинные имена):");
      Array.from(longCharsNames).forEach((name) => {
        console.log(`  - ${name}`);
      });
      console.log('Файл НЕ сохранён! Внеси имена в словарь!')
    } else {
      // Опции: добавляем BOM для корректного отображения кириллицы в Excel
      await csv.toDisk(`./csv/${filename}`);

      console.log(`\nCSV файл сохранён: ${filename}`);
    }
  }

  // Ожидание ввода пользователя
  console.log("\nНажмите Enter для выхода...");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", process.exit.bind(process, 0));
})();
