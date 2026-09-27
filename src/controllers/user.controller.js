import api from "../config/api.js";
import User from "../models/User.js";

export const getUserInfo = async (req, res) => {
  try {
    // Get user info from external API using the token from request context
    const user = await api.get("/auth/user_info");

    // If the user is not found in the database, create a new user
    const userData = await createUser(user);
    return res.status(200).json(userData);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};

// Creates a new user in the database if they don't already exist
const createUser = async (data) => {
  const existingUser = await User.findOne({ uid: data.uid });
  if (existingUser) return existingUser;

  const newUser = await User.create(data);
  return newUser;
};
