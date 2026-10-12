import Citizen from "../models/Citizen.js";
import { getRequestUser } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";

const PAGE_SIZE = 100;

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

/**
 * Mahallalar ro'yxati umumiy fuqarolar bazasidan hisoblanadi —
 * alohida jadval yo'q. Manzil erkin matn bo'lgani uchun har safar
 * qayta hisoblash qimmat (150 mingdan ortiq yozuv), shuning uchun
 * natija xotirada keshlanadi.
 *
 * Kesh fuqarolar soni o'zgarganda o'zini yangilaydi: fayl qayta
 * yuklansa, yozuvlar soni ham o'zgaradi.
 */
let cache = null;

export const invalidateMahallaCache = () => {
  cache = null;
};

const buildMahallas = async () => {
  // Faqat kerakli maydonlar — 150 ming to'liq hujjatni xotiraga
  // olish shart emas.
  const rows = await Citizen.aggregate([
    {
      $group: {
        _id: "$address",
        count: { $sum: 1 },
        cadasters: { $addToSet: "$cadasterNumber" },
        withPinfl: {
          $sum: { $cond: [{ $in: ["$pinfl", [null, ""]] }, 0, 1] },
        },
      },
    },
  ]);

  const byKey = new Map();

  for (const row of rows) {
    const name = extractMahallaName(row._id);
    if (!name) continue;

    const key = mahallaKey(name);
    if (!key) continue;

    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        // Nom turlicha yoziladi; eng ko'p uchragani asosiy deb
        // olinadi, qolganlari variant sifatida saqlanadi.
        nameCounts: new Map(),
        total: 0,
        withPinfl: 0,
        cadasters: new Set(),
        addresses: new Set(),
      });
    }

    const entry = byKey.get(key);
    entry.total += row.count;
    entry.withPinfl += row.withPinfl;
    entry.nameCounts.set(name, (entry.nameCounts.get(name) ?? 0) + row.count);
    if (row._id) entry.addresses.add(row._id);
    for (const cadaster of row.cadasters) {
      if (cadaster) entry.cadasters.add(cadaster);
    }
  }

  const items = [...byKey.values()]
    .map((entry) => {
      const names = [...entry.nameCounts.entries()].sort((a, b) => b[1] - a[1]);

      // Kadastr raqamining dastlabki bloklari hudud kodini beradi
      // ("17:03:01:02:06:0402" -> "17:03:01:02:06"). Mahalla uchun
      // eng ko'p uchragan kodni ko'rsatamiz.
      const prefixCounts = new Map();
      for (const cadaster of entry.cadasters) {
        const prefix = String(cadaster).split(":").slice(0, 5).join(":");
        if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      }
      const topPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0];

      return {
        key: entry.key,
        name: names[0][0],
        nameVariants: names.slice(1, 6).map(([value]) => value),
        total: entry.total,
        withPinfl: entry.withPinfl,
        withoutPinfl: entry.total - entry.withPinfl,
        cadasterPrefix: topPrefix ? topPrefix[0] : null,
        cadasterCount: entry.cadasters.size,
        addressCount: entry.addresses.size,
      };
    })
    .sort((a, b) => b.total - a.total);

  return items;
};

const getMahallas = async () => {
  const total = await Citizen.estimatedDocumentCount();

  // Fuqarolar soni o'zgargan bo'lsa kesh eskirgan.
  if (cache && cache.sourceTotal === total) return cache.items;

  const items = await buildMahallas();
  cache = { sourceTotal: total, items, builtAt: new Date() };

  return items;
};

/**
 * Mahallalar ro'yxati (qidiruv va sahifalash bilan).
 */
export const getMahallaList = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const page = parsePage(req.query.page);
    const search = String(req.query.search ?? "").trim();

    let items = await getMahallas();

    if (search) {
      // Qidiruvda ham bir xil kalit ishlatiladi — "Qiyali" deb
      // yozilsa "КИЯЛИ" ham topiladi.
      const needle = mahallaKey(search);
      const matches = (value) => {
        const candidate = mahallaKey(value);
        // Nom boshidan qidiramiz: "kol" so'rovi "ПОЛВОНКУЛ" ni emas,
        // "КЎЛ" va "КЎЛ БЎЙИ" ni topsin.
        return Boolean(needle) && candidate.startsWith(needle);
      };

      items = items.filter(
        (item) =>
          matches(item.name) ||
          item.nameVariants.some(matches) ||
          String(item.cadasterPrefix ?? "").includes(search),
      );
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * PAGE_SIZE;

    return res.status(200).json({
      items: items.slice(start, start + PAGE_SIZE),
      page: safePage,
      pageSize: PAGE_SIZE,
      total,
      totalPages,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Umumiy ko'rsatkichlar: nechta mahalla, nechta fuqaro.
 */
export const getMahallaStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const items = await getMahallas();

    const citizens = items.reduce((sum, item) => sum + item.total, 0);
    const withPinfl = items.reduce((sum, item) => sum + item.withPinfl, 0);
    const sourceTotal = await Citizen.estimatedDocumentCount();

    return res.status(200).json({
      total: items.length,
      citizens,
      withPinfl,
      // Manzilidan mahalla aniqlanmagan yozuvlar
      unresolved: sourceTotal - citizens,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Bitta mahalladagi fuqarolar ro'yxati.
 */
export const getMahallaCitizens = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const { key } = req.params;
    const items = await getMahallas();
    const mahalla = items.find((item) => item.key === key);

    if (!mahalla) {
      return res.status(404).json({ message: "Mahalla topilmadi" });
    }

    const page = parsePage(req.query.page);

    // Manzil bo'yicha regex bilan qidirib bo'lmaydi: qisqa nom
    // uzunrog'ining ichiga tushib ketadi ("КЎЛ" -> "КЎЛ БЎЙИ" ni ham
    // tortadi). Shuning uchun ro'yxatni qurgandagi aynan bir xil
    // mantiqdan foydalanamiz: manzildan nom ajratiladi va kaliti
    // solishtiriladi.
    const addresses = await Citizen.distinct("address");
    const matched = addresses.filter((address) => {
      const name = extractMahallaName(address);
      return name ? mahallaKey(name) === key : false;
    });

    const filter = { address: { $in: matched } };

    const total = await Citizen.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const citizens = await Citizen.find(filter)
      .sort({ rowNumber: 1, _id: 1 })
      .skip((safePage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();

    return res.status(200).json({
      mahalla,
      items: citizens,
      page: safePage,
      pageSize: PAGE_SIZE,
      total,
      totalPages,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
