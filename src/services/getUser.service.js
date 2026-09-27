import api from "../config/axios.js";

/**
 * Access token yordamida tashqi API'dan foydalanuvchi ma'lumotini oladi.
 * @param {string} accessToken
 * @returns {Promise<object>} foydalanuvchi ma'lumotlari
 */
export const getUserByToken = async (accessToken) => {
  const res = await api.get("/auth/user_info", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return res;
};

export default getUserByToken;
