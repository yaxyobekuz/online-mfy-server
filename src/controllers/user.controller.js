import { getRequestUser } from "../utils/request-context.js";

export const getUserInfo = async (req, res) => {
  // auth-context middleware tokenni allaqachon tekshirib, foydalanuvchini
  // tashqi API'dan olib, DB bilan sinxronlab, request context'ga yozgan.
  const user = getRequestUser();

  if (!user) {
    return res.status(401).json({ message: "Access key noto'g'ri" });
  }

  return res.status(200).json(user);
};
