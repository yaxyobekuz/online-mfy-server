import { checkPassword, createSession } from "../utils/session.js";

/**
 * POST /api/auth/login  { password }
 *
 * Serverning yagona paroli (.env: ADMIN_PASSWORD) tekshiriladi.
 * To'g'ri bo'lsa — imzolangan sessiya tokeni qaytadi. Shundan keyin
 * barcha so'rovlar shu sessiya bilan ketadi; MFY tokenlari esa
 * serverда turadi.
 */
export const login = (req, res) => {
  const { password } = req.body ?? {};

  if (!checkPassword(password)) {
    return res.status(401).json({ message: "Parol noto'g'ri" });
  }

  return res.status(200).json({ session: createSession() });
};
