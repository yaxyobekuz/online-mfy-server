import { requestContext } from "../utils/request-context.js";
import { fetchAndSyncUser } from "../services/user.service.js";

/**
 * Kiruvchi so'rovning "Authorization: Bearer <token>" headeridan tokenni
 * olib, shu so'rov davomida ishlaydigan AsyncLocalStorage context'iga
 * yozadi. Token bo'lsa, tashqi API'dan joriy foydalanuvchini ham olib,
 * shu context'ga qo'shadi ‒ shu so'rov davomida chaqirilgan istalgan
 * controller/service getRequestUser() orqali uni qayta so'rovsiz oladi.
 *
 * Token noto'g'ri/tashqi API ishlamasa ham so'rov to'xtatilmaydi: user
 * shunchaki undefined qoladi, himoyalangan route'lar buni o'zi tekshiradi.
 */
export const authContext = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  const store = { token, user: undefined };

  requestContext.run(store, async () => {
    if (token) {
      try {
        store.user = await fetchAndSyncUser();
      } catch {
        // Token yaroqsiz yoki tashqi API mavjud emas; user undefined qoladi.
      }
    }

    next();
  });
};
