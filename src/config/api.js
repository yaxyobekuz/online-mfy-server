import axios from "axios";
import {
  getRequestToken,
  getRequestMahallaUid,
} from "../utils/request-context.js";

const api = axios.create({
  baseURL: process.env.API_BASE_URL,
  // So'rov cheksiz osilib qolmasin: platforma sekinlashsa yoki
  // ulanish uzilsa, 35 soniyadan keyin uziladi. Bu ishchiga
  // boshqaruvni (to'xtatish) qayta o'qish imkonini beradi — aks
  // holda "To'xtatish" bosilgach ham so'rov tugaguncha kutilardi.
  timeout: 35000,
});

// Request — joriy MFY tokenini qo'yamiz (agar so'rovning o'zi
// token bermagan bo'lsa: token qo'shish/tekshirishda token to'g'ridan
// -to'g'ri beriladi).
api.interceptors.request.use((config) => {
  if (config.headers.Authorization) return config;

  const token = getRequestToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Response — platforma 401 (yaroqsiz token) qaytarsa, shu MFY tokenini
// "expired" deb belgilaymiz. Panel buni disabled ko'rinishida
// ko'rsatadi va foydalanuvchi yangilaydi.
//
// Belgilash fon-amal: javobni kutdirmaymiz, xatolik baribir yuqoriga
// uzatiladi.
api.interceptors.response.use(
  (res) => res.data,
  async (error) => {
    const status = error.response?.status;
    const uid = getRequestMahallaUid();

    if (status === 401 && uid) {
      // Dumaloq import bo'lmasligi uchun modelni shu yerda yuklaymiz.
      import("../models/MfyToken.js")
        .then(({ default: MfyToken }) =>
          MfyToken.updateOne(
            { uid },
            { $set: { status: "expired", lastCheckedAt: new Date() } },
          ),
        )
        .catch(() => {});
    }

    return Promise.reject(error);
  },
);

export default api;
