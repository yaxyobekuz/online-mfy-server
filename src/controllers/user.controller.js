import api from "../config/api.js";

export const getUserInfo = async (_req, res) => {
  try {
    const user = await api.get("/auth/user_info");
    return res.status(200).json(user);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};
