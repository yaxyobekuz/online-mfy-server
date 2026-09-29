import api from "../config/api.js";
import Street from "../models/Street.js";
import { getRequestUser } from "../utils/request-context.js";

// Foydalanuvchining DB'da saqlangan ko'chalarini qaytaradi
// (tashqi API'ga so'rov yubormasdan).
export const getUserStreets = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const streets = await Street.find({ userUid: user.uid }).sort({
      name: 1,
    });

    return res.status(200).json(streets);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

export const updateUserStreets = async (req, res) => {
  // Get user data
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const streets = await api.get("/api/v1/survey_homes/cache/street", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    });

    const streetsData = streets.data.results;

    // Foydalanuvchining eski ko'chalarini o'chirib, tashqi API'dan kelgan
    // yangi ro'yxat bilan almashtiramiz (tashqi ro'yxat manba hisoblanadi).
    await Street.deleteMany({ userUid: user.uid });

    const newStreets = await Street.insertMany(
      streetsData.map((street) => ({
        streetId: String(street.id),
        name: street.name,
        homesCount: street.homes_stat_count,
        homesSurveyedCount: street.homes_surveyed_count,
        populationCount: street.population_stat_count,
        populationSurveyedCount: street.population_surveyed_count,
        multistoryCount: street.multistory_count,
        yardCount: street.yard_count,
        dormitoryCount: street.dormitory_count,
        youthCount: street.youth_count,
        womenCount: street.women_count,
        pensionerCount: street.pensioner_count,
        defectsCount: street.defects_count,
        userUid: user.uid,
      })),
    );

    return res.status(200).json(newStreets);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};
