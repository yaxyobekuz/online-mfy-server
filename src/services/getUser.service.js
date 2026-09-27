import api from "../config/axios.js";

try {
  const res = await api.get("/auth/user_info");

  console.log("User info:", res);
} catch (err) {
  console.error("Error fetching user info:", err);
}
