import api from "../config/api.js";

export const getUserInfo = async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  try {
    const user = await api.get("/auth/user_info", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return res.status(200).json(user);
  } catch (err) {
    return res.json(err);
  }
};
