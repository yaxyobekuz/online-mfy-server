import axios from "axios";
import { getRequestToken } from "../utils/request-context.js";

const api = axios.create({
  baseURL: process.env.API_BASE_URL,
});

// Request
api.interceptors.request.use((config) => {
  const token = getRequestToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Response
api.interceptors.response.use((res) => res.data);

export default api;
