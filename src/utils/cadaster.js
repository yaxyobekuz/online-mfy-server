/**
 * Kadastr raqamini taqqoslash uchun bitta shaklga keltirish.
 *
 * Bir xil xonadon uch manbada uch xil yoziladi:
 *   fuqarolar bazasi (Excel):  "17:03:04:02:01:0001"
 *   platforma (survey_homes):  "17030102060377"
 *                              "17 030 302 020 150"
 *                              "17:03:40:01:02:0809/0001"
 * Ajratuvchi belgilar (`:`, probel, `/`) ma'no tashimaydi — ular
 * faqat o'qishni osonlashtiradi. Shuning uchun taqqoslashda hammasi
 * tashlanadi va FAQAT RAQAMLAR qoladi.
 *
 * Tekshirildi (Ko'l MFY, 1044 xonadon): aynan moslikda 651 xonadon
 * topilgan edi, raqamga tozalagandan keyin 671 — ya'ni 20 xonadon
 * faqat yozilish farqi tufayli chetda qolayotgan ekan.
 */
export const cadasterKey = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");

  // "-" yoki bo'sh qiymat — kadastri yo'q xonadon. Bunday yozuvlar
  // bir-biriga mos kelib qolmasligi uchun bo'sh qaytariladi.
  return digits || null;
};

/**
 * Kadastrlar ro'yxatidan "kalit -> asl qiymat(lar)" jadvali.
 * Bir kalitga bir nechta yozilish to'g'ri kelishi mumkin.
 */
export const cadasterIndex = (values) => {
  const index = new Map();

  for (const value of values) {
    const key = cadasterKey(value);
    if (!key) continue;

    const bucket = index.get(key);
    if (bucket) bucket.push(value);
    else index.set(key, [value]);
  }

  return index;
};
