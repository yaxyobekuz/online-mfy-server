import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Ko'cha va uning statistikasi.
 * Tashqi API: /api/v1/survey_homes/cache/street
 */
const streetSchema = new Schema(
  {
    // Unique Identifier
    streetId: { type: String, required: true },

    // Street Info
    name: { type: String, required: true },

    // Statistika
    homesCount: { type: Number, default: 0 }, // Uylar soni
    homesSurveyedCount: { type: Number, default: 0 }, // Tekshirilgan uylar soni
    populationCount: { type: Number, default: 0 }, // Aholi soni
    populationSurveyedCount: { type: Number, default: 0 }, // Tekshirilgan aholi soni
    multistoryCount: { type: Number, default: 0 }, // Ko'p qavatli uylar soni
    yardCount: { type: Number, default: 0 }, // Hovli (xonadonli) uylar soni
    dormitoryCount: { type: Number, default: 0 }, // Yotoqxonalar soni
    youthCount: { type: Number, default: 0 }, // Yoshlar soni
    womenCount: { type: Number, default: 0 }, // Ayollar soni
    pensionerCount: { type: Number, default: 0 }, // Pensionerlar soni
    defectsCount: { type: Number, default: 0 }, // Kamchiliklar soni

    // User
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export default model("Street", streetSchema);
