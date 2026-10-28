/**
 * Ro'yxatni tasodifiy tartibda qayta joylash (Fisher–Yates).
 *
 * Nega kerak: random rejimda bo'sh xonadon qidirish HAR SAFAR
 * birinchi ko'chaning birinchi xonadonidan boshlanardi. Oldingi
 * yurishlarda aynan o'sha boshlang'ich xonadonlar to'ldirilgani
 * uchun qidiruv tekshirish chegarasini (`MAX_PROBES`) o'sha
 * to'lganlarga sarflab, "bo'sh joyi bor xonadon topilmadi" deb
 * to'xtardi — ro'yxat ichkarisidagi bo'sh xonadonlarga umuman
 * yetib bormasdan.
 *
 * Aralashtirilgandan keyin har bir yurish ro'yxatning boshqa
 * joyidan boshlanadi, ya'ni chegara butun ro'yxat bo'ylab
 * bir tekis taqsimlanadi.
 *
 * Asl ro'yxat o'zgarmaydi — nusxa qaytariladi.
 */
export const shuffled = (items) => {
  const out = [...items];

  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
};
