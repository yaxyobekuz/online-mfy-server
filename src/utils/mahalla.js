/**
 * Mahalla nomini manzildan ajratib olish va turli yozilishlarni
 * bitta shaklga keltirish.
 *
 * Umumiy fuqarolar bazasida manzil erkin matn ko'rinishida keladi va
 * bir xil mahalla o'nlab xil yoziladi:
 *   "КЎЛ МФЙ, ОРЗИКУЛКОРИ КЎЧАСИ,  uy:Р/С"
 *   "KO`L MAHALLASI 2"
 *   "Кўл МФЙ Янгиобод кўчаси"
 * Shuning uchun nom ajratilgach, taqqoslash uchun alohida "kalit"
 * hisoblanadi — kirilldan lotinga o'tkazib, o'xshash tovushlar
 * birlashtiriladi.
 */

// Kirill -> lotin. Mahalla nomlari ikkala yozuvda ham uchraydi.
const CYRILLIC_TO_LATIN = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "YO", Ж: "J",
  З: "Z", И: "I", Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O",
  П: "P", Р: "R", С: "S", Т: "T", У: "U", Ф: "F", Х: "X", Ц: "TS",
  Ч: "CH", Ш: "SH", Щ: "SH", Ъ: "", Ы: "I", Ь: "", Э: "E", Ю: "YU",
  Я: "YA", Ў: "O", Қ: "Q", Ғ: "G", Ҳ: "H",
};

export const transliterate = (value) =>
  String(value ?? "")
    .toUpperCase()
    .split("")
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join("");

/**
 * Taqqoslash kaliti. Harf-raqamdan boshqasi tashlanadi, so'ng
 * manbada aralash ishlatiladigan tovushlar birlashtiriladi:
 * Q/K ("QIYALI" = "КИЯЛИ"), X/H ("SAXOVAT" = "SAHOVAT"),
 * O/U ("ПОЛВОНКЎЛ" = "ПОЛВОНКУЛ").
 */
export const mahallaKey = (name) =>
  transliterate(name)
    .replace(/[^A-Z0-9]/g, "")
    .replace(/Q/g, "K")
    .replace(/H/g, "X")
    .replace(/W/g, "V")
    .replace(/U/g, "O")
    .replace(/E/g, "A")
    .replace(/Y/g, "I");

/**
 * Yumshoqroq kalit — faqat IKKI NOMNI TAQQOSLASH uchun.
 *
 * `mahallaKey` da unli tovushlar qisman birlashtirilgan (U -> O),
 * lekin A va O alohida qolgan. Shuning uchun bir mahallaning ikki
 * xil yozilishi turli kalit berishi mumkin:
 *
 *   "САРНАВУЛ"  -> SARNAVOL
 *   "Сарновул"  -> SARNOVOL
 *
 * Bu ro'yxatni guruhlashda muammo emas (har ikkisi o'z guruhida
 * qoladi), lekin "shu mahallami yoki boshqasimi?" degan savolga
 * javob berishda xato beradi — odam o'z mahallasida turgani holda
 * "ko'chib ketgan" deb ko'rsatiladi.
 *
 * Shuning uchun taqqoslash uchun A va O ham birlashtiriladi.
 * Mahalliy 85 mahalla ro'yxatida bu qo'shimcha to'qnashuv
 * keltirmasligi tekshirilgan.
 *
 * DIQQAT: guruhlash uchun ishlatilmaydi — u yerda `mahallaKey`
 * qoladi, aks holda mavjud ma'lumot qayta hisoblanishi kerak
 * bo'lardi.
 */
export const sameMahalla = (a, b) => {
  const loose = (name) => mahallaKey(name).replace(/O/g, "A");

  const left = loose(a);
  const right = loose(b);

  return Boolean(left) && left === right;
};

// "МФЙ", "MAHALLASI" kabi belgilar — nom shulardan oldin turadi.
// Diqqat: \b faqat ASCII harflar bilan ishlaydi, kirill matnda hech
// qachon mos kelmaydi. Shuning uchun chegara qo'lda tekshiriladi.
const MAHALLA_MARKER =
  /(?:^|[\s,.])(MFY|МФЙ|МСГ|MSG|MAHALLASI|MAHALLA|MAXALLASI|MAXALLA|МАҲАЛЛАСИ|МАҲАЛЛА|МАХАЛЛАСИ|МАХАЛЛА)(?=$|[\s,.])/i;

// Mahalladan oldin qishloq/shaharcha/tuman nomi turishi mumkin
// ("BO`STON QISHLOG`I JARTEPA MAHALLASI"). Bunday holatda haqiqiy
// mahalla nomi shu belgidan KEYIN keladi.
const AREA_PREFIX =
  /(?:^|[\s,.])(QISHLOG[`'’]?I|QISHLOQ|ҚИШЛОҒИ|КИШЛОГИ|SHAXARCHASI|SHAHARCHASI|ШАХАРЧАСИ|ҚФЙ|QFY|КФЙ|K\.F\.Y\.?|Р\.|R\.)(?=$|[\s,.])/i;

/**
 * Manzil matnidan mahalla nomini ajratadi. Topilmasa null.
 */
export const extractMahallaName = (address) => {
  const text = String(address ?? "").trim();
  if (!text) return null;

  const marker = text.match(MAHALLA_MARKER);
  if (!marker) return null;

  // Marker boshigacha bo'lgan qism (oldidagi ajratuvchini qo'shmasdan)
  let name = text.slice(0, marker.index + (marker[0].length - marker[1].length));

  // Qishloq/tuman prefiksi bo'lsa, undan keyingi qism olinadi.
  const area = name.match(AREA_PREFIX);
  if (area) {
    name = name.slice(area.index + area[0].length);
  }

  name = name
    .replace(/[,.\-–—]+$/, "")
    .replace(/^[,.\-–—\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  // "SERQUYOSH MAHALLASI 1" kabi holatlarda uy raqami nomga
  // yopishib qolmasligi uchun oxiridagi yakka raqamni olib tashlaymiz.
  name = name.replace(/\s+\d+[A-Za-zА-Яа-я]?$/, "").trim();

  return name || null;
};
