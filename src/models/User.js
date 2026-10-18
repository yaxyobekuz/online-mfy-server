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

    // Bitta yurishda eng ko'pi bilan nechta odam KIRITILSIN.
    //
    // 0 — cheklov yo'q (standart holat). Musbat son berilsa, shuncha
    // odam muvaffaqiyatli qo'shilgach yurish o'zi to'xtaydi.
    //
    // Nega kerak: "Boshlash" bosilgach jarayon oxirigacha ketaverardi
    // va kerakdan ortiq odam kiritilib qolardi. Hisob HAR BIR YURISH
    // uchun alohida ketadi (yurish umri bo'yicha emas): tugmani
    // bosganda shuncha kiritiladi va to'xtaydi, keyin yana bossa —
    // yana shuncha.
    autoStopAfter: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default model("User", userSchema);
