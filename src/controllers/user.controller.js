import { getUserByToken } from "../services/getUser.service.js";

/**
 * GET /api/user
 * Client "Authorization: Bearer <accessKey>" header orqali yuborgan token
 * bilan tashqi API'dan foydalanuvchi ma'lumotini olib beradi.
 */
export const getUserInfo = async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  if (!token) {
    return res.status(401).json({ message: "Access key talab qilinadi" });
  }

  try {
    const user = await getUserByToken(token);
    return res.status(200).json(user);
  } catch (error) {
    const status = error.response?.status || 500;
    const message =
      error.response?.data?.message || "Foydalanuvchini olishda xatolik yuz berdi";

    return res.status(status).json({ message });
  }
};
