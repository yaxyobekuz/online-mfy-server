import axios from "axios";
import "./env.js";

const api = axios.create({
  baseURL: process.env.API_BASE_URL,
  headers: process.env.ACCESS_TOKEN
    ? { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` }
    : {},
});

// Response
api.interceptors.response.use((res) => res.data);

export default api;
