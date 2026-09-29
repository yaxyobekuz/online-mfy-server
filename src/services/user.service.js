import api from "../config/api.js";
import User from "../models/User.js";

/**
 * Tashqi API'dan (joriy so'rov tokeni bilan) foydalanuvchi ma'lumotini
 * oladi va MongoDB'ga saqlaydi (mavjud bo'lsa yangilaydi, bo'lmasa yaratadi).
 */
export const fetchAndSyncUser = async () => {
  const data = await api.get("/auth/user_info");

  const user = await User.findOneAndUpdate({ uid: data.uid }, data, {
    new: true,
    upsert: true,
  });

  return user;
};
