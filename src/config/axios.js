import axios from "axios";
import "./env.js";

const api = axios.create({
  baseURL: process.env.API_BASE_URL,
});

// Response
api.interceptors.response.use((res) => res.data);

export default api;
