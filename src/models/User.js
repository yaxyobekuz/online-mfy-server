import mongoose from "mongoose";

const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    // Unique Identifier
    uid: { type: String, index: true },

    // User Info
    username: { type: String, index: true },
    fullName: { type: String },

    // Area
    oblId: { type: Number }, // Viloyat
    districtId: { type: Number }, // Tuman/shahar
    areaId: { type: Number }, // Mahalla
    defStreetId: { type: Number }, // Ko'cha

    // Random rejimda ma'lumot KIRITILMAYDIGAN ko'chalar (streetId).
    //
    // Nega "istisno" ro'yxati, "ruxsat" emas: standart holat —
    // barcha ko'chaga kiritish mumkin. Platformada "номаълум" kabi
    // texnik ko'chalar bor, ularga fuqaro qo'shmaslik kerak. Agar
    // ruxsat ro'yxati saqlansa, yangi paydo bo'lgan ko'cha o'z-o'zidan
    // taqiqlanib qolardi — istisno ro'yxati esa yangi ko'chani
    // avtomatik ruxsat etadi.
    excludedStreetIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

export default model("User", userSchema);
